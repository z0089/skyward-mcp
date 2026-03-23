# Skyward MCP

`Skyward MCP` is a local MCP server for reading Skyward gradebook data.

It logs into Skyward directly over HTTP and does not use a browser.

## What It Can Do

- Read your gradebook summary across schools and classes
- List assignments for a class
- Open class-grade detail views
- Open assignment detail views
- Work directly against Skyward without a browser

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

The server requires `SKYWARD_LOGIN_ID` and `SKYWARD_PASSWORD`. It only uses direct Skyward requests.

Do not hardcode credentials into the project. Keep them in your shell environment or in your MCP client config, and keep local env files out of git.

## Smoke Test

With direct login settings set:

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

The `env` block matters if your MCP client launches the server as a child process. That is how the server receives the login settings.

## Notes

- This project reads Skyward gradebook data. It does not include the Better Skyward Chrome extension.
- This project is direct-login only.
