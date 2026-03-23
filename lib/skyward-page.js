const GRADEBOOK_URL = "https://student.canyonsdistrict.org/scripts/wsisa.dll/WService=wsEAplus/sfgradebook001.w";

function buildActionExpression(action, args = {}) {
  return `(${runSkywardAction.toString()})(${JSON.stringify(action)}, ${JSON.stringify(args)})`;
}

function runSkywardAction(action, args) {
  function cleanText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cleanBlockText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .split("\n")
      .map((line) => cleanText(line))
      .filter((line, index, lines) => line || (index > 0 && lines[index - 1] !== ""))
      .join("\n")
      .trim();
  }

  function removeScriptText(root) {
    root.querySelectorAll("script, style").forEach((element) => {
      element.remove();
    });
  }

  function htmlToText(html) {
    const documentFragment = new DOMParser().parseFromString(String(html || ""), "text/html");
    removeScriptText(documentFragment);
    return cleanBlockText(documentFragment.body ? documentFragment.body.innerText : "");
  }

  function ensureGradebookPage() {
    if (!/\/sfgradebook001\.w$/i.test(window.location.pathname)) {
      throw new Error(
        `Skyward is not on the gradebook page. Current page: ${window.location.pathname || window.location.href}`
      );
    }

    if (typeof window.sff !== "object" || typeof window.sff.request !== "function") {
      throw new Error("Skyward page helpers are not available yet. Refresh the gradebook page and try again.");
    }
  }

  function parseGridTag(tagElement) {
    const clone = tagElement.cloneNode(true);
    clone.querySelectorAll(".sf_menuContainer").forEach((element) => element.remove());

    const studentLabel = cleanText(clone.querySelector(".notranslate")?.textContent || "");
    const tagText = cleanText(clone.textContent);
    const schoolMatch = tagText.match(/\(([^)]+)\)/);

    return {
      studentLabel,
      schoolName: schoolMatch ? cleanText(schoolMatch[1]) : "",
      tagText
    };
  }

  function parseTermColumns(wrapElement) {
    return Array.from(wrapElement.querySelectorAll(".scrollHeader th")).map((headerCell, index) => ({
      index,
      termLabel: cleanText(headerCell.innerText),
      bucket: cleanText(headerCell.getAttribute("tooltip") || headerCell.innerText)
    }));
  }

  function parseCourseInfo(parentRow) {
    const descriptionTable = parentRow.querySelector('table[id^="classDesc_"]');
    const rows = descriptionTable ? Array.from(descriptionTable.querySelectorAll("tr")) : [];

    const className = cleanText(rows[0]?.querySelector(".classDesc")?.textContent || "");
    const periodRow = rows[1] || null;
    const teacher = cleanText(rows[2]?.textContent || "");
    const periodLabel = cleanText(periodRow?.querySelector("label")?.textContent || "");
    const schedule = cleanText(periodRow?.querySelector("span")?.textContent || "");
    let period = cleanText(periodRow?.textContent || "");

    if (periodLabel) {
      period = cleanText(period.replace(periodLabel, ""));
    }
    if (schedule) {
      period = cleanText(period.replace(schedule, ""));
    }

    const expander = descriptionTable?.querySelector(".sf_expander");

    return {
      className,
      period,
      schedule,
      teacher,
      expanderId: expander?.id || null
    };
  }

  function parseGradeCell(cellElement, termColumn) {
    const gradeLink = cellElement.querySelector('a[id="showGradeInfo"]');
    const value = cleanText(cellElement.innerText);

    return {
      termLabel: gradeLink?.dataset.lit || termColumn?.termLabel || "",
      bucket: gradeLink?.dataset.bkt || termColumn?.bucket || "",
      value,
      isClickable: Boolean(gradeLink),
      gradebookId: gradeLink?.dataset.gid || null,
      courseNumberId: gradeLink?.dataset.cni || null,
      track: gradeLink?.dataset.trk || null,
      section: gradeLink?.dataset.sec || null,
      isEndOfCourse: gradeLink?.dataset.iseoc || null
    };
  }

  function parseAssignmentRows(courseKey, fixedTable, scrollTable, termColumns) {
    const fixedRows = Array.from(fixedTable.querySelectorAll(`tr[group-child="${courseKey}"]`)).filter((row) =>
      row.querySelector('a[id="showAssignmentInfo"]')
    );

    return fixedRows.map((fixedRow) => {
      const rowNumber = fixedRow.getAttribute("data-rownum");
      const scrollRow = scrollTable.querySelector(
        `tr[group-child="${courseKey}"][data-rownum="${rowNumber}"]`
      );
      const assignmentLink = fixedRow.querySelector('a[id="showAssignmentInfo"]');
      const dueText = cleanText(fixedRow.querySelector("span.fXs.fIl")?.textContent || "");
      const dueMatch = dueText.match(/^(.*?)(?:\(([^)]+)\))?$/);
      const specialCodeInfo =
        scrollRow?.querySelector('a[id^="specCode_"]')?.dataset.info || null;
      const termScores = Array.from(scrollRow?.cells || [])
        .map((cellElement, index) => {
          const value = cleanText(cellElement.innerText);
          const cellSpecialCode = cellElement.querySelector('a[id^="specCode_"]')?.dataset.info || null;
          return {
            termLabel: termColumns[index]?.termLabel || "",
            bucket: termColumns[index]?.bucket || "",
            value,
            specialCodeInfo: cellSpecialCode
          };
        })
        .filter((entry) => entry.value || entry.specialCodeInfo);

      return {
        assignmentId: assignmentLink.dataset.aid,
        assignmentKey: `${courseKey}:${assignmentLink.dataset.aid}`,
        courseKey,
        title: cleanText(assignmentLink.textContent),
        dueDate: cleanText(dueMatch ? dueMatch[1] : dueText),
        termLabel: cleanText((dueMatch && dueMatch[2]) || ""),
        specialCodeInfo,
        scoreSummary: termScores.map((entry) => entry.value).filter(Boolean).join(" | "),
        termScores,
        studentId: assignmentLink.dataset.sid,
        requestEntityToken: assignmentLink.dataset.eid,
        gradebookId: assignmentLink.dataset.gid
      };
    });
  }

  function parseCourse(parentRow, scrollTable, termColumns, entityId, includeAssignments) {
    const courseKey = parentRow.getAttribute("group-parent");
    const scrollParentRow = scrollTable.querySelector(`tr[group-parent="${courseKey}"]`);
    const courseInfo = parseCourseInfo(parentRow);
    const courseKeyParts = String(courseKey || "").split("_");
    const termGrades = Array.from(scrollParentRow?.cells || []).map((cellElement, index) =>
      parseGradeCell(cellElement, termColumns[index])
    );

    const course = {
      courseKey,
      studentId: courseKeyParts[0] || "",
      entityId,
      courseNumberId: courseKeyParts[1] || "",
      track: courseKeyParts[2] || "",
      section: courseKeyParts[3] || "",
      className: courseInfo.className,
      period: courseInfo.period,
      schedule: courseInfo.schedule,
      teacher: courseInfo.teacher,
      expanderId: courseInfo.expanderId,
      termGrades
    };

    if (includeAssignments) {
      course.assignments = parseAssignmentRows(courseKey, parentRow.closest("table"), scrollTable, termColumns);
    }

    return course;
  }

  function getGridWraps() {
    return Array.from(document.querySelectorAll('div[id^="grid_stuGradesGrid_"][id$="_gridWrap"]'));
  }

  function getCourseByKey(courseKey) {
    const parentRow = document.querySelector(`.fixedRows tr[group-parent="${courseKey}"]`);
    if (!parentRow) {
      throw new Error(`Could not find course ${courseKey} in the current gradebook.`);
    }

    const fixedTable = parentRow.closest("table");
    const wrapElement = fixedTable.closest('[id$="_gridWrap"]');
    const wrapIdMatch = wrapElement.id.match(/^grid_stuGradesGrid_(\d+)_(\d+)_gridWrap$/);
    const entityId = wrapIdMatch ? wrapIdMatch[2] : "";
    const scrollTable = wrapElement.querySelector(".scrollRows table");
    const termColumns = parseTermColumns(wrapElement);

    return {
      wrapElement,
      fixedTable,
      scrollTable,
      termColumns,
      course: parseCourse(parentRow, scrollTable, termColumns, entityId, false)
    };
  }

  function makeRequest(endpoint, payload) {
    return new Promise((resolve) => {
      window.sff.request(endpoint, payload, resolve);
    });
  }

  async function getGradebookSummary(includeAssignments) {
    ensureGradebookPage();

    return {
      pageTitle: document.title,
      pageUrl: window.location.href,
      generatedAt: new Date().toISOString(),
      schools: getGridWraps().map((wrapElement) => {
        const wrapIdMatch = wrapElement.id.match(/^grid_stuGradesGrid_(\d+)_(\d+)_gridWrap$/);
        const studentId = wrapIdMatch ? wrapIdMatch[1] : "";
        const entityId = wrapIdMatch ? wrapIdMatch[2] : "";
        const fixedTable = wrapElement.querySelector(".fixedRows table");
        const scrollTable = wrapElement.querySelector(".scrollRows table");
        const termColumns = parseTermColumns(wrapElement);
        const tagInfo = parseGridTag(wrapElement.querySelector(".sfTag"));
        const showAssignmentsLink = wrapElement.querySelector(`#showAssignmentsLink_${studentId}_${entityId}`);
        const parentRows = Array.from(fixedTable.querySelectorAll("tr[group-parent]"));

        return {
          studentId,
          entityId,
          studentLabel: tagInfo.studentLabel,
          schoolName: tagInfo.schoolName,
          tagText: tagInfo.tagText,
          assignmentsExpanded: showAssignmentsLink?.dataset.show === "yes",
          termColumns,
          courses: parentRows.map((parentRow) =>
            parseCourse(parentRow, scrollTable, termColumns, entityId, includeAssignments)
          )
        };
      })
    };
  }

  async function getCourseAssignments(courseKey) {
    ensureGradebookPage();

    const { fixedTable, scrollTable, termColumns, course } = getCourseByKey(courseKey);
    const assignments = parseAssignmentRows(courseKey, fixedTable, scrollTable, termColumns);

    return {
      course,
      assignments
    };
  }

  async function getGradeDetails(courseKey, bucket, termLabel) {
    ensureGradebookPage();

    const gradeLinks = Array.from(
      document.querySelectorAll(`.scrollRows tr[group-parent="${courseKey}"] a[id="showGradeInfo"]`)
    );
    const gradeLink =
      gradeLinks.find((link) => (bucket ? link.dataset.bkt === bucket : false)) ||
      gradeLinks.find((link) => (termLabel ? link.dataset.lit === termLabel : false)) ||
      gradeLinks[0];

    if (!gradeLink) {
      throw new Error(`Could not find a grade link for course ${courseKey}.`);
    }

    const response = await makeRequest("sfgradebook001.w", {
      action: "viewGradeInfoDialog",
      gridCount: window.sff.getValue("gridCount"),
      fromHttp: "yes",
      stuId: gradeLink.dataset.sid,
      entityId: gradeLink.dataset.eid,
      corNumId: gradeLink.dataset.cni,
      track: gradeLink.dataset.trk,
      section: window.sff.revertCharReplaceForId(gradeLink.dataset.sec),
      gbId: gradeLink.dataset.gid,
      bucket: gradeLink.dataset.bkt,
      subjectId: gradeLink.dataset.subjid || "",
      dialogLevel: gradeLink.dataset.childlvl ? parseInt(gradeLink.dataset.childlvl, 10) + 1 : 1,
      isEoc: gradeLink.dataset.iseoc
    });

    if (response.status !== "success") {
      throw new Error(`Skyward grade details request failed with status: ${response.status}`);
    }

    const dialogDocument = new DOMParser().parseFromString(response.output, "text/html");
    removeScriptText(dialogDocument);

    return {
      courseKey,
      termLabel: gradeLink.dataset.lit,
      bucket: gradeLink.dataset.bkt,
      className: cleanText(dialogDocument.querySelector("h2.gb_heading a")?.textContent || ""),
      teacher: cleanText(
        dialogDocument.querySelectorAll("h2.gb_heading a")[1]?.textContent || ""
      ),
      text: cleanBlockText(dialogDocument.body?.innerText || ""),
      html: response.output
    };
  }

  async function getAssignmentDetails(assignmentId, courseKey) {
    ensureGradebookPage();

    const assignmentLinks = Array.from(document.querySelectorAll('a[id="showAssignmentInfo"]'));
    const assignmentLink = assignmentLinks.find((link) => {
      if (link.dataset.aid !== assignmentId) {
        return false;
      }

      if (!courseKey) {
        return true;
      }

      const row = link.closest("tr[group-child]");
      return row && row.getAttribute("group-child") === courseKey;
    });

    if (!assignmentLink) {
      throw new Error(`Could not find assignment ${assignmentId} in the current gradebook.`);
    }

    const response = await makeRequest("sfdialogs.w", {
      action: "dialog",
      student: assignmentLink.dataset.sid,
      gbId: assignmentLink.dataset.gid,
      assignId: assignmentLink.dataset.aid,
      eid: assignmentLink.dataset.eid,
      type: "assignment"
    });

    if (response.status !== "success") {
      throw new Error(`Skyward assignment details request failed with status: ${response.status}`);
    }

    const dialogDocument = new DOMParser().parseFromString(response.output, "text/html");
    removeScriptText(dialogDocument);
    const headingLinks = dialogDocument.querySelectorAll("h2.gb_heading a");
    const titleRow = dialogDocument.querySelector("#grid_assignmentDialog tbody tr");
    const titleText = cleanText(titleRow?.textContent || "");
    const titleMatch = titleText.match(/^(.*?)(?:\(Category:\s*([^)]+)\))?$/);

    const fields = {};
    Array.from(dialogDocument.querySelectorAll("#grid_assignmentDialog tbody tr")).forEach((rowElement) => {
      const cells = Array.from(rowElement.querySelectorAll("td"));
      for (let index = 0; index < cells.length - 1; index += 2) {
        const label = cleanText(cells[index].textContent);
        const value = cleanText(cells[index + 1].textContent);
        if (label && value) {
          fields[label.replace(/:$/, "")] = value;
        }
      }
    });

    return {
      assignmentId,
      courseKey: courseKey || assignmentLink.closest("tr[group-child]")?.getAttribute("group-child") || "",
      className: cleanText(headingLinks[0]?.textContent || ""),
      teacher: cleanText(headingLinks[1]?.textContent || ""),
      title: cleanText(titleMatch ? titleMatch[1] : titleText),
      category: cleanText((titleMatch && titleMatch[2]) || ""),
      fields,
      text: cleanBlockText(dialogDocument.body?.innerText || ""),
      html: response.output
    };
  }

  switch (action) {
    case "getGradebookSummary":
      return getGradebookSummary(Boolean(args.includeAssignments));
    case "getCourseAssignments":
      return getCourseAssignments(String(args.courseKey || ""));
    case "getGradeDetails":
      return getGradeDetails(String(args.courseKey || ""), cleanText(args.bucket), cleanText(args.termLabel));
    case "getAssignmentDetails":
      return getAssignmentDetails(String(args.assignmentId || ""), cleanText(args.courseKey));
    default:
      throw new Error(`Unsupported Skyward action: ${action}`);
  }
}

module.exports = {
  GRADEBOOK_URL,
  buildActionExpression
};
