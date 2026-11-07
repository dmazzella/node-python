"""Inventory model used by module.ts.

A plain Python module, unaware of Node.js: classes, a dataclass, a custom
exception, a generator, and a function taking a callback.
"""

import json
from collections.abc import Callable, Iterator
from dataclasses import asdict, dataclass


class OutOfStock(Exception):
    """Raised when removing more items than available."""

    def __init__(self, name: str, requested: int, available: int):
        super().__init__(f"{name}: requested {requested}, available {available}")
        self.name = name
        self.requested = requested
        self.available = available


@dataclass
class Item:
    name: str
    price: float
    quantity: int = 0

    @property
    def total(self) -> float:
        return round(self.price * self.quantity, 2)


class Inventory:
    def __init__(self, owner: str):
        self.owner = owner
        self.items: dict[str, Item] = {}

    def add(self, name: str, price: float, quantity: int = 1) -> Item:
        item = self.items.setdefault(name, Item(name, price))
        item.price = price
        item.quantity += quantity
        return item

    def remove(self, name: str, quantity: int = 1) -> Item:
        item = self.items.get(name)
        available = item.quantity if item else 0
        if available < quantity:
            raise OutOfStock(name, quantity, available)
        item.quantity -= quantity
        return item

    def total_value(self) -> float:
        return round(sum(item.total for item in self.items.values()), 2)

    def low_stock(self, threshold: int = 2) -> Iterator[str]:
        for item in self.items.values():
            if item.quantity <= threshold:
                yield item.name

    def report(self, formatter: Callable[[dict], str] = str) -> list[str]:
        return [formatter(asdict(item)) for item in sorted(self.items.values(), key=lambda i: i.name)]

    def to_json(self) -> str:
        return json.dumps({"owner": self.owner, "items": [asdict(i) for i in self.items.values()]})

    def __iter__(self) -> Iterator[Item]:
        return iter(self.items.values())

    def __len__(self) -> int:
        return len(self.items)

    def __repr__(self) -> str:
        return f"Inventory(owner={self.owner!r}, items={len(self)}, value={self.total_value()})"
