---
kind: lesson
applies: Local production deploys
review: "2027-01-15"
---

## Why

A build picked up `.env.local` and pointed at the wrong database.

## How to apply

Move `.env.local` aside before building; poll the deploy state.
