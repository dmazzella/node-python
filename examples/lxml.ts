// lxml — XML processing through Python's libxml2/libxslt bindings.
//
// Usage:
//   python -m pip install lxml
//   PYTHON="$(python -c 'import sys; print(sys.executable)')" node examples/lxml.ts

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Python, PythonError, kwargs, type PythonObject } from "@node-ctypes/python";

const namespace = "urn:node-python:invoice";
const namespaces = { inv: namespace };
const xml = Buffer.from(`
<inv:invoice xmlns:inv="${namespace}" id="INV-2026-001" currency="EUR">
  <inv:customer>Acme &amp; Sons</inv:customer>
  <inv:items>
    <inv:item sku="KEYBOARD" quantity="2" unit-price="49.90">Keyboard</inv:item>
    <inv:item sku="MOUSE" quantity="1" unit-price="19.50">Mouse</inv:item>
  </inv:items>
</inv:invoice>
`);

const xsd = Buffer.from(`
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           targetNamespace="${namespace}" xmlns:inv="${namespace}"
           elementFormDefault="qualified">
  <xs:element name="invoice">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="customer" type="xs:string"/>
        <xs:element name="items">
          <xs:complexType>
            <xs:sequence>
              <xs:element name="item" maxOccurs="unbounded">
                <xs:complexType>
                  <xs:simpleContent>
                    <xs:extension base="xs:string">
                      <xs:attribute name="sku" type="xs:string" use="required"/>
                      <xs:attribute name="quantity" type="xs:positiveInteger" use="required"/>
                      <xs:attribute name="unit-price" type="xs:decimal" use="required"/>
                    </xs:extension>
                  </xs:simpleContent>
                </xs:complexType>
              </xs:element>
            </xs:sequence>
          </xs:complexType>
        </xs:element>
      </xs:sequence>
      <xs:attribute name="id" type="xs:string" use="required"/>
      <xs:attribute name="currency" type="xs:string" use="required"/>
    </xs:complexType>
  </xs:element>
</xs:schema>
`);

const stylesheet = Buffer.from(`
<xsl:stylesheet version="1.0"
                xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
                xmlns:inv="${namespace}" exclude-result-prefixes="inv">
  <xsl:output method="text" encoding="UTF-8"/>
  <xsl:param name="heading"/>
  <xsl:template match="/">
    <xsl:value-of select="$heading"/><xsl:text>&#10;</xsl:text>
    <xsl:for-each select="inv:invoice/inv:items/inv:item">
      <xsl:value-of select="@sku"/><xsl:text>:</xsl:text>
      <xsl:value-of select="@quantity"/><xsl:text>&#10;</xsl:text>
    </xsl:for-each>
  </xsl:template>
</xsl:stylesheet>
`);

async function expectPythonError(action: () => unknown, expected: string): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof PythonError)) throw error;
    try {
      assert.equal(error.type, expected);
      return error.message;
    } finally {
      error.exception[Symbol.dispose]();
    }
  }
  assert.fail(`Expected Python ${expected}`);
}

const python = await Python.initialize({ stdin: false });

let lxml: PythonObject;
try {
  lxml = await python.import("lxml");
} catch (error) {
  if (!(error instanceof PythonError) || error.type !== "ModuleNotFoundError" || error.exception.name !== "lxml") throw error;
  console.log(`lxml is not installed for Python ${python.version} (${python.executable}): skipped`);
  console.log("Install it with this interpreter using -m pip install lxml, or set PYTHON to the interpreter where it is installed.");
  error.exception[Symbol.dispose]();
  await python.finalize();
  process.exit(0);
}

try {
  using lxmlModule = lxml;
  using etree = await python.import("lxml.etree");
  console.log(`lxml ${lxmlModule.__version__} from Node.js (Python ${python.version})`);
  console.log(`libxml2 ${etree.LIBXML_VERSION}, libxslt ${etree.LIBXSLT_VERSION}\n`);
  const ns = kwargs({ namespaces });

  // [1] a hardened parser: no entities, no DTD, no network
  console.log("[1] parse XML bytes and read namespaced elements");
  const parserOptions = kwargs({ resolve_entities: false, load_dtd: false, no_network: true, remove_blank_text: true });
  using parser: PythonObject = await etree.XMLParser(parserOptions);
  using root: PythonObject = await etree.fromstring(xml, parser);
  const id: string = await root.get("id");
  const customer: string = await root.findtext("inv:customer", ns);
  assert.equal(root.tag, `{${namespace}}invoice`);
  assert.equal(id, "INV-2026-001");
  assert.equal(customer, "Acme & Sons");
  console.log(`    ${id}: ${customer}\n`);

  // [2] XPath: $minimum is bound from a keyword argument
  console.log("[2] XPath with namespaces and bound variables");
  assert.equal(await root.xpath("count(inv:items/inv:item)", ns), 2);
  assert.equal(await root.xpath("sum(inv:items/inv:item/@quantity)", ns), 3);
  // Plain strings do not retain the XML tree through lxml's smart-string owners.
  const expensive = "inv:items/inv:item[@unit-price > $minimum]/@sku";
  using selected: PythonObject = await root.xpath(expensive, kwargs({ namespaces, minimum: 30, smart_strings: false }));
  const skus = selected.toJS<string[]>();
  assert.deepEqual(skus, ["KEYBOARD"]);
  console.log(`    unit-price > 30: ${skus.join(", ")}\n`);

  // [3] add an <inv:item>, serialize to bytes (a Buffer) and parse them back
  console.log("[3] edit the tree and serialize to a Node.js Buffer");
  using items: PythonObject = await root.find("inv:items", ns);
  assert.ok(items);
  const attrib = { sku: "CABLE", quantity: "3", "unit-price": "4.25" };
  using added: PythonObject = await etree.SubElement(items, `{${namespace}}item`, kwargs({ attrib }));
  added.text = "Cable";
  const serialized: Buffer = await etree.tostring(root, kwargs({ xml_declaration: true, encoding: "UTF-8", pretty_print: true }));
  assert.ok(Buffer.isBuffer(serialized));
  assert.match(serialized.toString("utf8"), /sku="CABLE"/);
  using roundtrip: PythonObject = await etree.fromstring(serialized, parser);
  assert.equal(await roundtrip.xpath("count(inv:items/inv:item)", ns), 3);
  console.log(`    ${serialized.length} bytes, 3 items after round-trip\n`);

  // [4] XML Schema: the invoice is valid, a copy with quantity="zero" is not
  console.log("[4] XSD validation and a rejected invalid quantity");
  using schemaDocument: PythonObject = await etree.fromstring(xsd, parser);
  using schema: PythonObject = await etree.XMLSchema(schemaDocument);
  assert.equal(await schema.validate(root), true);
  await schema.assertValid(root);

  using invalid: PythonObject = await etree.fromstring(serialized, parser);
  using invalidItem: PythonObject = await invalid.find("inv:items/inv:item", ns);
  await invalidItem.set("quantity", "zero");
  assert.equal(await schema.validate(invalid), false);
  const validationError = await expectPythonError(() => schema.assertValid(invalid), "DocumentInvalid");
  assert.match(validationError, /quantity/);
  console.log(`    valid invoice accepted; ${validationError.split("\n")[0]}\n`);

  // [5] XSLT without file or network access; strparam quotes the value
  console.log("[5] XSLT with a literal string parameter");
  using stylesheetDocument: PythonObject = await etree.fromstring(stylesheet, parser);
  using access: PythonObject = etree.XSLTAccessControl.DENY_ALL;
  using transform: PythonObject = await etree.XSLT(stylesheetDocument, kwargs({ access_control: access }));
  using heading: PythonObject = await etree.XSLT.strparam("Invoice summary");
  using result: PythonObject = await transform(root, kwargs({ heading }));
  const report: Buffer = await python.builtins.bytes(result);
  assert.ok(Buffer.isBuffer(report));
  assert.equal(report.toString("utf8"), "Invoice summary\nKEYBOARD:2\nMOUSE:1\nCABLE:3\n");
  console.log(report.toString("utf8"));

  // [6] the same canonical bytes from the edited tree and its round-trip
  console.log("[6] exclusive C14N and a SHA-256 digest");
  // Canonicalization and hashing are not XML signing or signature verification.
  const c14n = kwargs({ method: "c14n", exclusive: true, with_comments: false });
  const canonical: Buffer = await etree.tostring(root, c14n);
  const canonicalRoundtrip: Buffer = await etree.tostring(roundtrip, c14n);
  assert.ok(Buffer.isBuffer(canonical));
  assert.deepEqual(canonical, canonicalRoundtrip);
  assert.match(canonical.toString("utf8"), /<inv:item quantity="2" sku="KEYBOARD" unit-price="49.90">/);
  const digest = createHash("sha256").update(canonical).digest("hex");
  console.log(`    ${canonical.length} canonical bytes, SHA-256 ${digest}\n`);

  // [7] lxml exceptions keep their Python type
  console.log("[7] malformed XML surfaces as PythonError");
  const malformed = Buffer.from("<invoice><item></invoice>");
  const syntaxError = await expectPythonError(() => etree.fromstring(malformed, parser), "XMLSyntaxError");
  assert.match(syntaxError, /mismatch/);
  console.log(`    ${syntaxError.split("\n")[0]}`);
  console.log("\nDone!");
} finally {
  await python.finalize();
}
