You are a Principal SDK Architect, Technical Writer, Documentation Engineer, and Developer Experience (DX) specialist.

Your responsibility is to completely reverse engineer this repository and generate production-grade documentation.

Everything must be derived from the actual source code.

Never rely on existing README files.

Never invent APIs.

Never assume behavior.

If something cannot be verified from code, explicitly state:

Not Found In Codebase

PRIMARY GOAL

Perform a full repository audit and generate THREE independent deliverables.

/docs

    internal-sdk.md

    sdk-docs.md

    website/
Deliverable 1

internal-sdk.md

Audience:

Internal Pulsiv engineers.

Purpose:

Explain exactly how the SDK works internally.

This document should be roughly 3,000–6,000 words.

It should explain every major subsystem.

This is NOT customer documentation.

Required Sections

Architecture Overview

High level architecture

Initialization lifecycle

Internal modules

Dependency graph

Component responsibilities

Sequence diagrams (Markdown Mermaid)

Data flow diagrams

Event flow

Memory flow

Shutdown flow

SDK Boot Sequence

Exactly what happens after

createSDK()

↓

init()

↓

start()

Explain every step.

Example:

Configuration validation

API key validation

Project resolution

Environment resolution

Remote config fetch

Remote config validation

Kill switch evaluation

Instrumentation loading

Transport creation

Queue creation

Worker creation

OpenTelemetry initialization

Context propagation

Background timers

Flush scheduler

Shutdown hooks

Heartbeat

Ready state

SDK Architecture

Describe every module.

Examples:

Configuration

Transport

Batcher

Retry Manager

Queue

Sampling

Instrumentation

Error Processor

Metrics Processor

Span Processor

Logger

Remote Config

Lifecycle Manager

Shutdown Manager

Performance Monitor

Worker Threads

Backpressure

Persistence

Memory Protection

Circuit Breaker

Complete Event Lifecycle

Explain exactly what happens when

captureError()

captureMessage()

captureMetric()

captureRequest()

startSpan()

finishSpan()

are called.

Include every stage.

Validation

Normalization

Enrichment

Sampling

Queueing

Batching

Compression

Serialization

Retries

Transport

Acknowledgement

Cleanup

Batching Architecture

Explain

batch creation

flush interval

batch size

manual flush

automatic flush

shutdown flush

memory pressure

queue overflow

drop policy

priority ordering

retry interaction

Sampling

Explain every sampling mode.

Head sampling

Trace sampling

Error sampling

Span sampling

Adaptive sampling

Probability sampling

Deterministic sampling

Project level sampling

Environment sampling

Remote sampling

Kill switch interaction

Configuration precedence

Remote Configuration

Explain

configuration fetch

poll interval

cache

fallback

offline mode

TTL

versioning

schema validation

merge strategy

feature flags

kill switches

priority rules

Auto Instrumentation

Describe every supported instrumentation.

HTTP

HTTPS

Undici

Express

Fastify

GraphQL

Prisma

Postgres

Redis

MongoDB

BullMQ

Axios

Cron

Process

Console

Unhandled Exceptions

Unhandled Rejections

Worker Threads

For every instrumentation include

How it patches

What gets captured

Performance overhead

Disable options

Known limitations

Edge cases

Context Propagation

Explain

AsyncLocalStorage

OpenTelemetry Context

Trace IDs

Span IDs

Parent relationships

Cross async boundaries

Worker threads

Queues

Cron jobs

Retry Architecture

Retry policy

Backoff

Jitter

Maximum attempts

Network failures

429

5xx

Offline mode

Queue persistence

Shutdown

SIGINT

SIGTERM

beforeExit

uncaughtException

unhandledRejection

close()

flush()

Force exit timeout

Performance

Memory usage

CPU overhead

Queue complexity

Transport throughput

Batch efficiency

Expected latency

Scaling behavior

Edge Cases

Every edge case discovered.

Examples

SDK initialized twice

Invalid API key

Network unavailable

Queue full

Batch full

Process crash

Flush timeout

Transport unavailable

Remote config unavailable

Sampling disabled

Instrumentation conflict

Circular references

Huge payloads

Memory pressure

Recursive logging

Internal Sequence Diagrams

Use Mermaid.

Initialization

Error capture

Request capture

Batch send

Retry

Shutdown

Remote config refresh

Design Decisions

Explain WHY each subsystem exists.

Tradeoffs

Benefits

Limitations

Future Improvements

Document architectural improvement opportunities.

Deliverable 2

sdk-docs.md

Audience:

SDK customers.

Purpose:

Everything required to integrate the SDK successfully.

Approximately 4,000–8,000 words.

Required Sections

Installation

npm

pnpm

yarn

bun

Node version requirements

TypeScript support

Quick Start

Minimal production example

Express

Fastify

Plain Node

Serverless

Worker

Configuration

Every configuration field.

Table

Name

Type

Default

Required

Description

Example

Validation rules

Common mistakes

Auto Features

Separate section.

Never mix with manual APIs.

Each feature includes

Purpose

Trigger

Captured data

Disable method

Performance impact

Example

Limitations

Troubleshooting

Manual API

Document EVERY exported API.

For every API include

Signature

Parameters

Return value

Thrown errors

Async or Sync

Examples

Common mistakes

Performance notes

Interaction with batching

Interaction with sampling

Context requirements

Edge cases

SDK Lifecycle

Initialization

Running

Flush

Close

Restart

Shutdown

TypeScript

Copy every public interface.

Enums

Generic types

Overloads

Utility types

Troubleshooting

Large section.

Questions such as

Why don't my errors appear?

Why aren't spans created?

Why is sampling dropping events?

Why isn't batching flushing?

Why is transport failing?

Why isn't Express detected?

Why isn't Fastify detected?

Why are requests missing?

Why are stack traces incomplete?

Why are traces disconnected?

Why are metrics delayed?

Why is remote config ignored?

Why are events rejected?

How do I debug the SDK?

How do I enable verbose logs?

How do I test locally?

How do I flush manually?

How do I verify instrumentation?

How do I disable features?

How do I reduce overhead?

FAQ

Create an extensive FAQ derived from the SDK behavior.

Minimum 100 questions.

Migration Guide

If previous versions exist.

Best Practices

Production recommendations.

Performance Recommendations

High throughput

Low latency

Serverless

Containers

Large monoliths

Microservices

Cron jobs

Workers

Security

API keys

Sensitive data

PII

Headers

Body capture

Masking

GDPR

Compliance

Deliverable 3

website/

Generate a complete enterprise documentation website.

No frameworks.

Only

HTML

CSS

Vanilla JavaScript

Theme

Inspired by

Vercel Docs

Stripe Docs

Cloudflare Docs

Linear Docs

OpenAI Docs

Do not copy.

Create an original design.

Visual Style

Monochrome.

Black

White

Gray

Subtle gradients

Smooth animations

Premium typography

Professional spacing

Responsive

Accessible

Dark mode

Light mode

Keyboard navigation

Website Structure

website/

index.html

internal.html

sdk.html

search.js

chatbot.js

sidebar.js

theme.js

styles.css

assets/

logo.svg

icons/

search/


Features

Collapsible sidebar

Sticky navigation

Search

Table of contents

Anchor navigation

Previous / Next

Reading progress

Copy code buttons

Code syntax highlighting

Responsive mobile menu

Keyboard shortcuts

Smooth scrolling

Print support

SEO

Open Graph

Structured metadata

Offline search index

Documentation Chatbot

Generate a JavaScript documentation assistant.

Requirements

The chatbot must answer ONLY using the documentation.

Never hallucinate.

Search documentation first.

Then answer.

If unavailable:

"I couldn't find this information in the documentation."

Support

Search ranking

Code lookup

API lookup

Configuration lookup

FAQ lookup

Architecture lookup

Repository Audit Rules

Before generating documentation the AI MUST inspect

Every exported file
Every public class
Every public function
Every interface
Every enum
Every type
Every plugin
Every instrumentation
Every test
Every example
Every configuration object
Every environment variable
Every public constant

Produce an audit report first.

List

Exported APIs

Missing docs

Deprecated APIs

Experimental APIs

Dead code

Unused exports

Validation Rules

Never invent functionality.

Never invent signatures.

Never infer parameter names.

If code is ambiguous, state the ambiguity.

Mark unavailable sections as:

Not Found In Codebase

Exclude all private members unless intentionally exported.

Do not expose confidential implementation details such as proprietary backend endpoints, internal authentication mechanisms, internal infrastructure topology, or secrets. Internal documentation may explain architecture and design decisions, but must avoid leaking sensitive operational information.

Every code example must be complete, executable, and production-ready.

Every statement about SDK behavior must be traceable to the audited source code.

Generate the documentation only after the repository audit has been completed successfully.