# Contributing

This project is intended to stay approachable for contributors reading it for the first time on GitHub.

## General style

Prefer:

- descriptive names over short names
- small helpers over repeated inline logic
- comments that explain intent, assumptions, and edge cases
- plain control flow over clever abstractions

Avoid:

- comments that restate obvious syntax
- broad utility layers that hide business logic
- changing unrelated formatting in the same patch

## Comments and documentation

Comments should answer one of these questions:

- why does this code exist?
- what edge case is being handled?
- what contract does another part of the system depend on?

Good examples:

- explaining why an agent token is regenerated only before first contact
- explaining why a route must survive partial token migration state
- explaining why a platform-specific branch exists

Bad examples:

- "increment counter"
- "set variable"
- "call function"

## Server code

The server is intentionally organized by route module and utility module.

When adding server code:

- keep route handlers focused on request/response behavior
- move reusable logic into `utils/` or small local helpers
- prefer one clear SQL query over layered indirection
- preserve the ability to run the dashboard locally with SQLite only

## Agent code

The agent has to run on multiple operating systems.

When adding agent code:

- keep platform checks close to the behavior they affect
- isolate OS-specific commands in helper functions
- prefer returning structured data rather than formatting output too early
- assume the machine may be partially configured or missing tools

## Frontend code

The frontend should feel operational, not generic.

When adding UI code:

- use in-app modals instead of browser-native popups
- keep command actions explicit and easy to audit
- prefer readable state names over condensed logic
- do not add visual noise just to look "modern"

## Pull request expectations

A good pull request should usually include:

- the direct change
- a short explanation of the behavior change
- any migration or rollout notes
- validation notes such as build checks or manual scenarios tested
