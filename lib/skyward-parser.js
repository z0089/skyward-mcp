const cheerio = require("cheerio");
const vm = require("node:vm");

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

function dataAttr($element, name) {
  const normalizedName = String(name || "").toLowerCase();
  return (
    $element.attr(`data-${normalizedName}`) ??
    $element.attr(`data-${name}`) ??
    null
  );
}

function htmlToText(html) {
  const source = String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|tr|li|h1|h2|h3|h4|h5|h6|table)>/gi, "\n")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  const $ = cheerio.load(source);
  return cleanBlockText($.root().text());
}

function extractGridObjectsLiteral(html) {
  const source = String(html || "");
  const anchorPattern =
    /sff\.sv\('sf_gridObjects',\s*\$\.extend\(\(sff\.getValue\('sf_gridObjects'\)\s*\|\|\s*\{\}\),\s*/;
  const anchorMatch = anchorPattern.exec(source);
  if (!anchorMatch) {
    return null;
  }

  let index = anchorMatch.index + anchorMatch[0].length;
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let cursor = index; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(index, cursor + 1);
      }
    }
  }

  return null;
}

function parseGridObjects(html) {
  const objectLiteral = extractGridObjectsLiteral(html);
  if (!objectLiteral) {
    return {};
  }

  try {
    return vm.runInNewContext(`(${objectLiteral})`, {});
  } catch (error) {
    return {};
  }
}

function getRowAttribute(rowHtml, attributeName) {
  const escapedAttributeName = String(attributeName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(rowHtml || "").match(
    new RegExp(`${escapedAttributeName}=(['"])(.*?)\\1`, "i")
  );
  return match ? match[2] : null;
}

function getCellElement(cellHtml, selector) {
  const wrappedHtml =
    selector === "td" || selector === "th"
      ? `<table><tr>${cellHtml || ""}</tr></table>`
      : cellHtml || "";
  const fragment = cheerio.load(wrappedHtml);
  return {
    $: fragment,
    element: fragment(selector).first()
  };
}

function parseGridTag($, $tagElement) {
  const fragment = cheerio.load($.html($tagElement));
  fragment(".sf_menuContainer").remove();
  const studentLabel = cleanText(fragment(".notranslate").first().text());
  const tagText = cleanText(fragment.root().text());
  const schoolMatch = tagText.match(/\(([^)]+)\)/);

  return {
    studentLabel,
    schoolName: schoolMatch ? cleanText(schoolMatch[1]) : "",
    tagText
  };
}

function parseTermColumns($wrapElement) {
  const $headerCells = $wrapElement.find(".scrollHeader th");
  return $headerCells.toArray().map((headerCell, index) => {
    const $headerCell = $headerCells.eq(index);
    return {
      index,
      termLabel: cleanText($headerCell.text()),
      bucket: cleanText($headerCell.attr("tooltip") || $headerCell.text())
    };
  });
}

function parseTermColumnsFromGridData(gridData) {
  return (gridData?.th?.r?.[0]?.c || [])
    .slice(1)
    .map((cell, index) => {
      const { $, element } = getCellElement(cell.h, "th");
      return {
        index,
        termLabel: cleanText(element.text()),
        bucket: cleanText(element.attr("tooltip") || element.text())
      };
    });
}

function parseCourseInfoTable($descriptionTable) {
  const $rows = $descriptionTable.find("tr");
  const $periodRow = $rows.eq(1);

  const className = cleanText($rows.eq(0).find(".classDesc").first().text());
  const teacher = cleanText($rows.eq(2).text());
  const periodLabel = cleanText($periodRow.find("label").first().text());
  const schedule = cleanText($periodRow.find("span").first().text());
  let period = cleanText($periodRow.text());

  if (periodLabel) {
    period = cleanText(period.replace(periodLabel, ""));
  }
  if (schedule) {
    period = cleanText(period.replace(schedule, ""));
  }

  return {
    className,
    period,
    schedule,
    teacher,
    expanderId: $descriptionTable.find(".sf_expander").first().attr("id") || null
  };
}

function parseCourseInfo($parentRow) {
  const $descriptionTable = $parentRow.find('table[id^="classDesc_"]').first();
  return parseCourseInfoTable($descriptionTable);
}

function parseGradeCell($, $cellElement, termColumn) {
  const $gradeLink = $cellElement.find('a[id="showGradeInfo"]').first();
  return {
    termLabel: dataAttr($gradeLink, "lit") || termColumn?.termLabel || "",
    bucket: dataAttr($gradeLink, "bkt") || termColumn?.bucket || "",
    value: cleanText($cellElement.text()),
    isClickable: $gradeLink.length > 0,
    gradebookId: dataAttr($gradeLink, "gid"),
    courseNumberId: dataAttr($gradeLink, "cni"),
    track: dataAttr($gradeLink, "trk"),
    section: dataAttr($gradeLink, "sec"),
    isEndOfCourse: dataAttr($gradeLink, "iseoc")
  };
}

function parseAssignmentRows($, courseKey, $fixedTable, $scrollTable, termColumns) {
  return $fixedTable
    .find(`tr[group-child="${courseKey}"]`)
    .toArray()
    .filter((rowElement) => $(rowElement).find('a[id="showAssignmentInfo"]').length > 0)
    .map((rowElement) => {
      const $fixedRow = $(rowElement);
      const rowNumber = $fixedRow.attr("data-rownum");
      const $scrollRow = $scrollTable
        .find(`tr[group-child="${courseKey}"][data-rownum="${rowNumber}"]`)
        .first();
      const $assignmentLink = $fixedRow.find('a[id="showAssignmentInfo"]').first();
      const dueText = cleanText($fixedRow.find("span.fXs.fIl").first().text());
      const dueMatch = dueText.match(/^(.*?)(?:\(([^)]+)\))?$/);
      const specialCodeInfo =
        dataAttr($scrollRow.find('a[id^="specCode_"]').first(), "info") || null;

      const termScores = $scrollRow
        .children("td")
        .toArray()
        .map((cellElement, index) => {
          const $cellElement = $(cellElement);
          return {
            termLabel: termColumns[index]?.termLabel || "",
            bucket: termColumns[index]?.bucket || "",
            value: cleanText($cellElement.text()),
            specialCodeInfo:
              dataAttr($cellElement.find('a[id^="specCode_"]').first(), "info") || null
          };
        })
        .filter((entry) => entry.value || entry.specialCodeInfo);

      return {
        assignmentId: dataAttr($assignmentLink, "aid"),
        assignmentKey: `${courseKey}:${dataAttr($assignmentLink, "aid")}`,
        courseKey,
        title: cleanText($assignmentLink.text()),
        dueDate: cleanText(dueMatch ? dueMatch[1] : dueText),
        termLabel: cleanText((dueMatch && dueMatch[2]) || ""),
        specialCodeInfo,
        scoreSummary: termScores.map((entry) => entry.value).filter(Boolean).join(" | "),
        termScores,
        studentId: dataAttr($assignmentLink, "sid"),
        requestEntityToken: dataAttr($assignmentLink, "eid"),
        gradebookId: dataAttr($assignmentLink, "gid")
      };
    });
}

function parseAssignmentRowsFromGridData(courseKey, rows, termColumns) {
  return rows
    .filter((row) => getRowAttribute(row.h, "group-child") === courseKey)
    .filter((row) => /showAssignmentInfo/.test(row.c?.[0]?.h || ""))
    .map((row) => {
      const firstCellHtml = row.c?.[0]?.h || "";
      const { $, element: $fixedCell } = getCellElement(firstCellHtml, "td");
      const $assignmentLink = $fixedCell.find('a[id="showAssignmentInfo"]').first();
      const dueText = cleanText($fixedCell.find("span.fXs.fIl").first().text());
      const dueMatch = dueText.match(/^(.*?)(?:\(([^)]+)\))?$/);
      const termScores = (row.c || [])
        .slice(1)
        .map((cell, index) => {
          const { $, element } = getCellElement(cell.h, "td");
          const specialCodeInfo =
            dataAttr(element.find('a[id^="specCode_"]').first(), "info") || null;
          return {
            termLabel: termColumns[index]?.termLabel || "",
            bucket: termColumns[index]?.bucket || "",
            value: cleanText(element.text()),
            specialCodeInfo
          };
        })
        .filter((entry) => entry.value || entry.specialCodeInfo);

      return {
        assignmentId: dataAttr($assignmentLink, "aid"),
        assignmentKey: `${courseKey}:${dataAttr($assignmentLink, "aid")}`,
        courseKey,
        title: cleanText($assignmentLink.text()),
        dueDate: cleanText(dueMatch ? dueMatch[1] : dueText),
        termLabel: cleanText((dueMatch && dueMatch[2]) || ""),
        specialCodeInfo:
          termScores.find((entry) => entry.specialCodeInfo)?.specialCodeInfo || null,
        scoreSummary: termScores.map((entry) => entry.value).filter(Boolean).join(" | "),
        termScores,
        studentId: dataAttr($assignmentLink, "sid"),
        requestEntityToken: dataAttr($assignmentLink, "eid"),
        gradebookId: dataAttr($assignmentLink, "gid")
      };
    });
}

function parseCourse($, $parentRow, $scrollTable, termColumns, entityId, includeAssignments) {
  const courseKey = $parentRow.attr("group-parent");
  const $scrollParentRow = $scrollTable.find(`tr[group-parent="${courseKey}"]`).first();
  const courseInfo = parseCourseInfo($parentRow);
  const courseKeyParts = String(courseKey || "").split("_");

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
    termGrades: $scrollParentRow
      .children("td")
      .toArray()
      .map((cellElement, index) => parseGradeCell($, $(cellElement), termColumns[index]))
  };

  if (includeAssignments) {
    const $fixedTable = $parentRow.closest("table");
    course.assignments = parseAssignmentRows($, courseKey, $fixedTable, $scrollTable, termColumns);
  }

  return course;
}

function parseCourseFromGridData(courseInfoMap, row, termColumns, entityId, includeAssignments, rows) {
  const courseKey = getRowAttribute(row.h, "group-parent") || "";
  const courseKeyParts = String(courseKey || "").split("_");
  const descriptionHtml = courseInfoMap.get(courseKey) || "";
  const courseInfoFragment = cheerio.load(descriptionHtml || "");
  const courseInfo = parseCourseInfoTable(courseInfoFragment('table[id^="classDesc_"]').first());

  const termGrades = (row.c || [])
    .slice(1)
    .map((cell, index) => {
      const { $, element } = getCellElement(cell.h, "td");
      return parseGradeCell($, element, termColumns[index]);
    });

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
    course.assignments = parseAssignmentRowsFromGridData(courseKey, rows, termColumns);
  }

  return course;
}

function parseGradebookSummaryFromSource(html, includeAssignments = false) {
  const source = String(html || "");
  const $ = cheerio.load(source);
  const gridObjects = parseGridObjects(source);
  const courseInfoMap = new Map();

  $('table[id^="classDesc_"]').each((_, tableElement) => {
    const $table = $(tableElement);
    const id = $table.attr("id") || "";
    if (id.startsWith("classDesc_")) {
      courseInfoMap.set(id.slice("classDesc_".length), $.html($table));
    }
  });

  const schools = $('div[id^="grid_stuGradesGrid_"][id$="_gridWrap"]')
    .toArray()
    .map((wrapElement) => {
      const $wrapElement = $(wrapElement);
      const wrapIdMatch = ($wrapElement.attr("id") || "").match(/^grid_stuGradesGrid_(\d+)_(\d+)_gridWrap$/);
      const studentId = wrapIdMatch ? wrapIdMatch[1] : "";
      const entityId = wrapIdMatch ? wrapIdMatch[2] : "";
      const tagInfo = parseGridTag($, $wrapElement.find(".sfTag").first());
      const $showAssignmentsLink = $wrapElement.find(`#showAssignmentsLink_${studentId}_${entityId}`).first();
      const gridData = gridObjects[`stuGradesGrid_${studentId}_${entityId}`] || null;
      const rows = gridData?.tb?.r || [];
      const termColumns = parseTermColumnsFromGridData(gridData);
      const parentRows = rows.filter((row) => getRowAttribute(row.h, "group-parent"));

      return {
        studentId,
        entityId,
        studentLabel: tagInfo.studentLabel,
        schoolName: tagInfo.schoolName,
        tagText: tagInfo.tagText,
        assignmentsExpanded: $showAssignmentsLink.attr("data-show") === "yes",
        termColumns,
        courses: parentRows.map((row) =>
          parseCourseFromGridData(courseInfoMap, row, termColumns, entityId, includeAssignments, rows)
        )
      };
    });

  return {
    pageTitle: cleanText($("title").first().text()),
    pageUrl: "",
    generatedAt: new Date().toISOString(),
    schools
  };
}

function parseGradebookSummary(html, includeAssignments = false) {
  const $ = cheerio.load(String(html || ""));
  const hasRenderedRows = $('div[id^="grid_stuGradesGrid_"][id$="_gridWrap"] .fixedRows tr[group-parent]').length > 0;
  if (!hasRenderedRows) {
    return parseGradebookSummaryFromSource(html, includeAssignments);
  }

  const schools = $('div[id^="grid_stuGradesGrid_"][id$="_gridWrap"]')
    .toArray()
    .map((wrapElement) => {
      const $wrapElement = $(wrapElement);
      const wrapIdMatch = ($wrapElement.attr("id") || "").match(/^grid_stuGradesGrid_(\d+)_(\d+)_gridWrap$/);
      const studentId = wrapIdMatch ? wrapIdMatch[1] : "";
      const entityId = wrapIdMatch ? wrapIdMatch[2] : "";
      const $fixedTable = $wrapElement.find(".fixedRows table").first();
      const $scrollTable = $wrapElement.find(".scrollRows table").first();
      const termColumns = parseTermColumns($wrapElement);
      const tagInfo = parseGridTag($, $wrapElement.find(".sfTag").first());
      const $showAssignmentsLink = $wrapElement.find(`#showAssignmentsLink_${studentId}_${entityId}`).first();

      return {
        studentId,
        entityId,
        studentLabel: tagInfo.studentLabel,
        schoolName: tagInfo.schoolName,
        tagText: tagInfo.tagText,
        assignmentsExpanded: $showAssignmentsLink.attr("data-show") === "yes",
        termColumns,
        courses: $fixedTable
          .find("tr[group-parent]")
          .toArray()
          .map((parentRow) =>
            parseCourse($, $(parentRow), $scrollTable, termColumns, entityId, includeAssignments)
          )
      };
    });

  return {
    pageTitle: cleanText($("title").first().text()),
    pageUrl: "",
    generatedAt: new Date().toISOString(),
    schools
  };
}

function parseCourseAssignments(html, courseKey) {
  const summary = parseGradebookSummary(html, true);
  for (const school of summary.schools) {
    const course = school.courses.find((candidate) => candidate.courseKey === courseKey);
    if (course) {
      return {
        course: { ...course, assignments: undefined },
        assignments: course.assignments || []
      };
    }
  }

  throw new Error(`Could not find course ${courseKey} in the current gradebook.`);
}

function findGradeLink(html, courseKey, bucket, termLabel) {
  const $ = cheerio.load(String(html || ""));
  const links = $(`.scrollRows tr[group-parent="${courseKey}"] a[id="showGradeInfo"]`).toArray();
  const candidates = links.map((element) => $(element));
  const selected =
    candidates.find((link) => (bucket ? dataAttr(link, "bkt") === bucket : false)) ||
    candidates.find((link) => (termLabel ? dataAttr(link, "lit") === termLabel : false)) ||
    candidates[0];

  if (!selected) {
    const summary = parseGradebookSummary(html, false);
    for (const school of summary.schools) {
      const course = school.courses.find((candidate) => candidate.courseKey === courseKey);
      if (!course) {
        continue;
      }

      const termGrade =
        course.termGrades.find((grade) => (bucket ? grade.bucket === bucket : false)) ||
        course.termGrades.find((grade) => (termLabel ? grade.termLabel === termLabel : false)) ||
        course.termGrades.find((grade) => grade.isClickable) ||
        null;

      if (termGrade) {
        return {
          studentId: course.studentId,
          entityId: course.entityId,
          courseNumberId: course.courseNumberId,
          track: course.track,
          section: course.section,
          gradebookId: termGrade.gradebookId,
          bucket: termGrade.bucket,
          termLabel: termGrade.termLabel,
          subjectId: "",
          childLevel: null,
          isEndOfCourse: termGrade.isEndOfCourse
        };
      }
    }

    throw new Error(`Could not find a grade link for course ${courseKey}.`);
  }

  return {
    studentId: dataAttr(selected, "sid"),
    entityId: dataAttr(selected, "eid"),
    courseNumberId: dataAttr(selected, "cni"),
    track: dataAttr(selected, "trk"),
    section: dataAttr(selected, "sec"),
    gradebookId: dataAttr(selected, "gid"),
    bucket: dataAttr(selected, "bkt"),
    termLabel: dataAttr(selected, "lit"),
    subjectId: dataAttr(selected, "subjid") || "",
    childLevel: dataAttr(selected, "childlvl"),
    isEndOfCourse: dataAttr(selected, "iseoc")
  };
}

function findAssignmentLink(html, assignmentId, courseKey) {
  const $ = cheerio.load(String(html || ""));
  const candidates = $('a[id="showAssignmentInfo"]')
    .toArray()
    .map((element) => $(element))
    .filter((link) => dataAttr(link, "aid") === assignmentId)
    .filter((link) => {
      if (!courseKey) {
        return true;
      }
      const rowCourseKey = link.closest("tr[group-child]").attr("group-child");
      return rowCourseKey === courseKey;
    });

  const selected = candidates[0];
  if (!selected) {
    const summary = parseGradebookSummary(html, true);
    for (const school of summary.schools) {
      for (const course of school.courses) {
        if (courseKey && course.courseKey !== courseKey) {
          continue;
        }

        const assignment = (course.assignments || []).find(
          (candidate) => candidate.assignmentId === assignmentId
        );
        if (assignment) {
          return {
            assignmentId: assignment.assignmentId,
            studentId: assignment.studentId,
            gradebookId: assignment.gradebookId,
            requestEntityToken: assignment.requestEntityToken,
            courseKey: assignment.courseKey
          };
        }
      }
    }

    throw new Error(`Could not find assignment ${assignmentId} in the current gradebook.`);
  }

  return {
    assignmentId: dataAttr(selected, "aid"),
    studentId: dataAttr(selected, "sid"),
    gradebookId: dataAttr(selected, "gid"),
    requestEntityToken: dataAttr(selected, "eid"),
    courseKey:
      selected.closest("tr[group-child]").attr("group-child") ||
      courseKey ||
      ""
  };
}

function parseGradeDetails(html, courseKey, termLabel, bucket) {
  const $ = cheerio.load(String(html || ""));
  const headingLinks = $("h2.gb_heading a").toArray().map((element) => $(element));
  return {
    courseKey,
    termLabel: cleanText(termLabel),
    bucket: cleanText(bucket),
    className: cleanText(headingLinks[0]?.text() || ""),
    teacher: cleanText(headingLinks[1]?.text() || ""),
    text: htmlToText(html),
    html
  };
}

function parseAssignmentDetails(html, assignmentId, courseKey) {
  const $ = cheerio.load(String(html || ""));
  const headingLinks = $("h2.gb_heading a").toArray().map((element) => $(element));
  const titleRowText = cleanText($("#grid_assignmentDialog tbody tr").first().text());
  const titleMatch = titleRowText.match(/^(.*?)(?:\(Category:\s*([^)]+)\))?$/);
  const fields = {};

  $("#grid_assignmentDialog tbody tr")
    .toArray()
    .forEach((rowElement) => {
      const cells = $(rowElement).children("td").toArray();
      for (let index = 0; index < cells.length - 1; index += 2) {
        const label = cleanText($(cells[index]).text()).replace(/:$/, "");
        const value = cleanText($(cells[index + 1]).text());
        if (label && value) {
          fields[label] = value;
        }
      }
    });

  return {
    assignmentId,
    courseKey,
    className: cleanText(headingLinks[0]?.text() || ""),
    teacher: cleanText(headingLinks[1]?.text() || ""),
    title: cleanText(titleMatch ? titleMatch[1] : titleRowText),
    category: cleanText((titleMatch && titleMatch[2]) || ""),
    fields,
    text: htmlToText(html),
    html
  };
}

function matchSffValue(html, key) {
  const expression = new RegExp(`sff\\.sv\\('${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}', '([^']*)'\\)`);
  const match = String(html || "").match(expression);
  return match ? match[1] : null;
}

function parseSessionContext(html) {
  const sessionMatch = String(html || "").match(/id=["']sessionid["'][^>]*value=["']([^"']+)["']/i);
  return {
    sessionId: sessionMatch ? sessionMatch[1] : null,
    encses: matchSffValue(html, "encses"),
    dwd: matchSffValue(html, "dwd"),
    wfaacl: matchSffValue(html, "wfaacl"),
    nameid: matchSffValue(html, "nameid"),
    gridCount: matchSffValue(html, "gridCount") || "1",
    filesAdded: matchSffValue(html, "filesAdded") || ""
  };
}

function parseExtraInfoResponse(responseText) {
  const source = String(responseText || "");
  const cdataMatch = source.match(/<extra><!\[CDATA\[([\s\S]*?)\]\]><\/extra>/i);
  if (cdataMatch) {
    return cdataMatch[1].trim();
  }

  const tagMatch = source.match(/<extra>([\s\S]*?)<\/extra>/i);
  if (tagMatch) {
    return cleanText(tagMatch[1]);
  }

  return cleanBlockText(htmlToText(source) || source);
}

function parseHttpLoaderResponse(responseText) {
  const source = String(responseText || "");
  const outputMatch = source.match(/<output><!\[CDATA\[([\s\S]*?)\]\]><\/output>/i);
  const statusMatch = source.match(/status:"([^"]+)"/i);

  return {
    status: statusMatch ? statusMatch[1] : outputMatch ? "success" : "unknown",
    output: outputMatch ? outputMatch[1] : "",
    raw: source
  };
}

module.exports = {
  cleanText,
  cleanBlockText,
  htmlToText,
  parseGradebookSummary,
  parseCourseAssignments,
  findGradeLink,
  findAssignmentLink,
  parseGradeDetails,
  parseAssignmentDetails,
  parseSessionContext,
  parseExtraInfoResponse,
  parseHttpLoaderResponse
};
