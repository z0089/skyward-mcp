# Skyward MCP

`Skyward MCP` is a local MCP server for reading Skyward gradebook data.

It can log into Skyward directly over HTTP, so the normal setup does not need a browser at all. It can also fall back to an open Chrome Skyward tab if direct credentials are not provided.

## What It Can Do

- Read your gradebook summary across schools and classes
- List assignments for a class
- Open class-grade detail views
- Open assignment detail views
- Work directly against Skyward without a browser when login settings are provided

## Available Tools

- `get_gradebook_summary`
- `get_course_assignments`
- `get_grade_details`
- `get_assignment_details`

## Install

```bash
npm install
```

## Run

```bash
npm start
```

## Browserless Setup

Set these before starting the server:

```bash
export SKYWARD_LOGIN_ID='your-login'
export SKYWARD_PASSWORD='your-password'
export SKYWARD_LOGIN_AREA='family/student'
```

Optional:

```bash
export SKYWARD_SECURITY_CODE='123456'
export SKYWARD_DESTINATION='sfgradebook001.w'
```

When `SKYWARD_LOGIN_ID` and `SKYWARD_PASSWORD` are set, the server uses direct Skyward requests and does not need Chrome.

Do not hardcode credentials into the project. Keep them in your shell environment or in your MCP client config, and keep local env files out of git.

## Chrome Fallback

If direct login settings are not present, the server can read from an already-open Skyward gradebook tab in Chrome.

If needed, set:

```bash
export SKYWARD_CHROME_WS_ENDPOINT='ws://127.0.0.1:9222/devtools/browser/...'
```

## Smoke Test

With direct login settings set, or with Chrome open to Skyward Gradebook:

```bash
npm run smoke-test
```

## MCP Client Setup

Example server entry:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/Skyward MCP/skyward-mcp.js"],
  "env": {
    "SKYWARD_LOGIN_ID": "your-login",
    "SKYWARD_PASSWORD": "your-password",
    "SKYWARD_LOGIN_AREA": "family/student"
  }
}
```

The `env` block matters if your MCP client launches the server as a child process. That is how the server receives the login settings for browserless mode.

## Notes

- This project reads Skyward gradebook data. It does not include the Better Skyward Chrome extension.
- Direct login is the preferred mode.
- Browser fallback is kept for cases where direct login is not available.
