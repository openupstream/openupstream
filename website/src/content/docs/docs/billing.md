---
title: Usage and billing
description: The four billed units (memory, CPU, storage and egress), what each Resource is billed for, and how to see what a Project uses now.
---

:::note
The hosted service does not invoice yet, and prices are not published.
This page describes how usage is counted.
:::

## Units

| Unit | What is counted |
| --- | --- |
| Memory, in GB-hours | The memory you configured, for as long as the Resource exists or runs. |
| CPU, in seconds | The CPU actually used, not what you configured. |
| Storage, in GB-hours | A Database's configured storage; what a Bucket holds. |
| Egress, in GB | Bytes sent to the internet in HTTP responses, for your Domains and Buckets. |

A GB is 2^30 bytes.

## Per Resource

| Resource | Billed by |
| --- | --- |
| Database | memory, CPU, storage |
| Bucket | storage, egress |
| Static site | through its Bucket |
| Service | memory, CPU, egress |
| Job | memory for the time its Runs take, CPU |

Not billed:

- the copies in other Sites: a Database's standby, the three copies of an
  object and the backups are in the unit price
- traffic inside the platform, such as a Service talking to its Database
- connections a Service opens to the internet
- Projects, Domains, Routes, Secrets and certificates

## What a Project uses now

The dashboard's Project page shows every Resource with its instances and
what each uses now: CPU, memory and, for a Database, disk. `oup usage`
prints the same as a table, with `--instances` every running copy too.
The API has it as `GET /v1/projects/{id}/usage`, `getUsage` in the
[SDK](/docs/reference/sdk/). It is the use right now, not what is billed.

## Paying

An Account needs a payment method before its first Resource: a card,
PayPal or SEPA Direct Debit. Usage is invoiced once a month, one invoice
per Account, broken down per Project.
