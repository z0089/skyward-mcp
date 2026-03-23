#!/usr/bin/env node

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["skyward-mcp.js"],
    cwd: process.cwd(),
    env: process.env,
    stderr: "pipe"
  });

  const client = new Client({
    name: "skyward-smoke-test",
    version: "1.0.0"
  });

  if (transport.stderr) {
    transport.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });
  }

  await client.connect(transport);

  const tools = await client.listTools();
  console.log(`Tools: ${tools.tools.map((tool) => tool.name).join(", ")}`);

  const summaryResult = await client.callTool({
    name: "get_gradebook_summary",
    arguments: {}
  });

  const summary = summaryResult.structuredContent;
  console.log(
    `Schools: ${summary.schools.length}, first school: ${summary.schools[0]?.schoolName || "n/a"}, first class: ${summary.schools[0]?.courses[0]?.className || "n/a"}`
  );

  const firstCourse = summary.schools[0]?.courses[0];
  if (!firstCourse) {
    throw new Error("Smoke test could not find any classes in the gradebook summary.");
  }

  const assignmentListResult = await client.callTool({
    name: "get_course_assignments",
    arguments: {
      courseKey: firstCourse.courseKey
    }
  });

  const assignments = assignmentListResult.structuredContent.assignments;
  console.log(
    `Assignments for ${firstCourse.className}: ${assignments.length}, first assignment: ${assignments[0]?.title || "n/a"}`
  );

  const clickableGrade =
    firstCourse.termGrades.find((termGrade) => termGrade.isClickable && termGrade.value) || null;
  if (!clickableGrade) {
    throw new Error("Smoke test could not find a clickable class grade.");
  }

  const gradeDetailsResult = await client.callTool({
    name: "get_grade_details",
    arguments: {
      courseKey: firstCourse.courseKey,
      termLabel: clickableGrade.termLabel
    }
  });

  console.log(
    `Grade details: ${gradeDetailsResult.structuredContent.className} ${gradeDetailsResult.structuredContent.termLabel}`
  );

  if (assignments[0]) {
    const assignmentDetailsResult = await client.callTool({
      name: "get_assignment_details",
      arguments: {
        assignmentId: assignments[0].assignmentId,
        courseKey: firstCourse.courseKey
      }
    });

    console.log(`Assignment details: ${assignmentDetailsResult.structuredContent.title}`);
  }

  await client.close();
  await transport.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
