#!/usr/bin/env node

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const { SkywardHttpClient } = require("./lib/skyward-http.js");

const directClient = new SkywardHttpClient();

async function evaluateSkywardAction(action, args) {
  if (!directClient.hasCredentials()) {
    throw new Error(
      "Skyward MCP now requires SKYWARD_LOGIN_ID and SKYWARD_PASSWORD in the server environment."
    );
  }

  switch (action) {
    case "getGradebookSummary":
      return directClient.getGradebookSummary(Boolean(args.includeAssignments));
    case "getCourseAssignments":
      return directClient.getCourseAssignments(String(args.courseKey || ""));
    case "getGradeDetails":
      return directClient.getGradeDetails(
        String(args.courseKey || ""),
        String(args.bucket || ""),
        String(args.termLabel || "")
      );
    case "getAssignmentDetails":
      return directClient.getAssignmentDetails(
        String(args.assignmentId || ""),
        String(args.courseKey || "")
      );
    default:
      throw new Error(`Unsupported Skyward action: ${action}`);
  }
}

function formatTextResult(title, payload) {
  return {
    content: [
      {
        type: "text",
        text: `${title}\n\n${JSON.stringify(payload, null, 2)}`
      }
    ],
    structuredContent: payload
  };
}

const server = new McpServer({
  name: "skyward-gradebook",
  version: "1.0.0"
});

server.registerTool(
  "get_gradebook_summary",
  {
    description:
      "Read the current Skyward gradebook and return schools, classes, term grades, and optional assignment lists. Requires direct Skyward login settings in the server environment.",
    inputSchema: {
      includeAssignments: z
        .boolean()
        .optional()
        .describe("When true, include assignment rows for each course.")
    }
  },
  async ({ includeAssignments = false }) => {
    const summary = await evaluateSkywardAction("getGradebookSummary", { includeAssignments });
    return formatTextResult("Skyward gradebook summary", summary);
  }
);

server.registerTool(
  "get_course_assignments",
  {
    description:
      "Return the assignment rows for a single Skyward course. Use courseKey from get_gradebook_summary.",
    inputSchema: {
      courseKey: z.string().min(1).describe("The courseKey returned by get_gradebook_summary.")
    }
  },
  async ({ courseKey }) => {
    const assignments = await evaluateSkywardAction("getCourseAssignments", { courseKey });
    return formatTextResult(`Assignments for ${courseKey}`, assignments);
  }
);

server.registerTool(
  "get_grade_details",
  {
    description:
      "Open the same hidden Skyward grade dialog Skyward uses and return its contents for a class term grade.",
    inputSchema: {
      courseKey: z.string().min(1).describe("The courseKey returned by get_gradebook_summary."),
      bucket: z.string().optional().describe("The Skyward bucket label, such as TERM 2."),
      termLabel: z.string().optional().describe("The short term label, such as Q2.")
    }
  },
  async ({ courseKey, bucket, termLabel }) => {
    const details = await evaluateSkywardAction("getGradeDetails", { courseKey, bucket, termLabel });
    return formatTextResult(`Grade details for ${courseKey}`, details);
  }
);

server.registerTool(
  "get_assignment_details",
  {
    description:
      "Open the same hidden Skyward assignment dialog Skyward uses and return its contents for one assignment.",
    inputSchema: {
      assignmentId: z.string().min(1).describe("The assignmentId returned by get_course_assignments."),
      courseKey: z
        .string()
        .optional()
        .describe("Optional courseKey to disambiguate assignments with the same ID across views.")
    }
  },
  async ({ assignmentId, courseKey }) => {
    const details = await evaluateSkywardAction("getAssignmentDetails", { assignmentId, courseKey });
    return formatTextResult(`Assignment details for ${assignmentId}`, details);
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Skyward MCP server error:", error);
  process.exit(1);
});
