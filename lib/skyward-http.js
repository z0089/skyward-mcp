const cheerio = require("cheerio");

const {
  cleanText,
  parseGradebookSummary,
  parseCourseAssignments,
  findGradeLink,
  findAssignmentLink,
  parseGradeDetails,
  parseAssignmentDetails,
  parseSessionContext,
  parseExtraInfoResponse,
  parseHttpLoaderResponse
} = require("./skyward-parser.js");

const BASE_URL = "https://student.canyonsdistrict.org/scripts/wsisa.dll/WService=wsEAplus/";
const LOGIN_URL = `${BASE_URL}seplog01.w`;
const LOGIN_ENDPOINT = `${BASE_URL}skyporthttp.w`;
const DEFAULT_DESTINATION = "sfgradebook001.w";

class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  addSetCookie(setCookieHeader) {
    const cookiePair = String(setCookieHeader || "").split(";")[0];
    const separatorIndex = cookiePair.indexOf("=");
    if (separatorIndex <= 0) {
      return;
    }

    const name = cookiePair.slice(0, separatorIndex).trim();
    const value = cookiePair.slice(separatorIndex + 1).trim();
    if (name) {
      this.cookies.set(name, value);
    }
  }

  capture(headers) {
    const setCookieHeaders =
      typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    setCookieHeaders.forEach((setCookieHeader) => {
      this.addSetCookie(setCookieHeader);
    });
  }

  toHeader() {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

function buildFormBody(values) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value == null) {
      return;
    }
    params.append(key, String(value));
  });
  return params.toString();
}

function parseFormFields(html) {
  const $ = cheerio.load(String(html || ""));
  const fields = {};

  $("input[name], textarea[name], select[name]").each((_, element) => {
    const $element = $(element);
    const name = $element.attr("name");
    if (!name) {
      return;
    }

    if (element.tagName === "select") {
      const selectedValue =
        $element.find("option[selected]").first().attr("value") ??
        $element.find("option").first().attr("value") ??
        "";
      fields[name] = selectedValue;
      return;
    }

    fields[name] = $element.attr("value") ?? $element.text() ?? "";
  });

  return fields;
}

function parseLoginContext(extraInfo) {
  const parts = String(extraInfo || "").split("^");
  return {
    dwd: parts[0] || "",
    webDataRecid: parts[1] || "",
    wfaaclRecid: parts[2] || "",
    wfaacl: parts[3] || "",
    nameid: parts[4] || "",
    duserid: parts[5] || "",
    userType: parts[6] || "",
    destinationProgram: parts[7] || DEFAULT_DESTINATION,
    showTracker: parts[8] || "",
    displaySecond: parts[10] || "",
    insecure: parts[11] || "",
    redirectTo: parts[12] || "",
    enc: parts[13] || "",
    encses: parts[14] || "",
    cookieName: parts[15] || "",
    cookieValue: parts[16] || "",
    prefersTopWindow: parts[17] === "yes"
  };
}

class SkywardHttpClient {
  constructor(options = {}) {
    this.loginId = options.loginId || process.env.SKYWARD_LOGIN_ID || "";
    this.password = options.password || process.env.SKYWARD_PASSWORD || "";
    this.securityCode = options.securityCode || process.env.SKYWARD_SECURITY_CODE || "";
    this.loginArea = options.loginArea ?? process.env.SKYWARD_LOGIN_AREA ?? "";
    this.destinationProgram =
      options.destinationProgram ||
      process.env.SKYWARD_DESTINATION ||
      DEFAULT_DESTINATION;
    this.browserName = "Chrome";
    this.browserVersion = "146";
    this.browserPlatform = "MacIntel";
    this.cookieJar = new CookieJar();
    this.loginFormFields = null;
    this.session = null;
  }

  hasCredentials() {
    return Boolean(this.loginId && this.password);
  }

  async fetchText(pathOrUrl, options = {}) {
    const url = /^https?:\/\//i.test(pathOrUrl)
      ? pathOrUrl
      : new URL(pathOrUrl, BASE_URL).toString();
    const headers = {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      ...(options.headers || {})
    };

    const cookieHeader = this.cookieJar.toHeader();
    if (cookieHeader) {
      headers.cookie = cookieHeader;
    }

    const response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body,
      redirect: "follow"
    });

    this.cookieJar.capture(response.headers);

    return {
      status: response.status,
      ok: response.ok,
      text: await response.text(),
      headers: response.headers,
      url: response.url
    };
  }

  async login() {
    if (!this.hasCredentials()) {
      throw new Error(
        "Direct Skyward mode needs SKYWARD_LOGIN_ID and SKYWARD_PASSWORD in the environment."
      );
    }

    const loginPage = await this.fetchText(LOGIN_URL);
    const fields = parseFormFields(loginPage.text);
    this.loginFormFields = fields;
    const requestBody = buildFormBody({
      requestAction: "eel",
      method: "extrainfo",
      codeType: "tryLogin",
      codeValue: "login",
      ...fields,
      login: this.loginId,
      password: this.password,
      securityCode: this.securityCode,
      cTrustDevice: "off",
      cUserRole: this.loginArea,
      screenWidth: "1440",
      screenHeight: "900",
      BrowserName: this.browserName,
      BrowserVersion: this.browserVersion,
      BrowserPlatform: this.browserPlatform,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      osName: "Mac",
      brwsInfo: "Chrome",
      subversion: this.browserVersion,
      supported: "true",
      pageused: "Desktop"
    });

    const loginResponse = await this.fetchText(LOGIN_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: requestBody
    });

    const extraInfo = parseExtraInfoResponse(loginResponse.text);
    if (!extraInfo.includes("^")) {
      if (/^Mfa/i.test(extraInfo)) {
        throw new Error(
          "Skyward requested a security code. Set SKYWARD_SECURITY_CODE and try again."
        );
      }

      throw new Error(extraInfo || "Skyward rejected the login.");
    }

    const loginContext = parseLoginContext(extraInfo);
    if (loginContext.cookieName && loginContext.cookieValue) {
      this.cookieJar.cookies.set(loginContext.cookieName, loginContext.cookieValue);
    }

    const gradebookPage = await this.establishGradebookPage(loginContext);
    const pageSession = parseSessionContext(gradebookPage.text);
    if (!pageSession.sessionId) {
      throw new Error(
        "Skyward login succeeded, but the gradebook page did not expose a session ID."
      );
    }

    this.session = {
      loginContext,
      pageSession,
      pageHtml: gradebookPage.text,
      fetchedAt: Date.now()
    };

    return this.session;
  }

  async establishGradebookPage(loginContext) {
    const destinationUrl = new URL(this.destinationProgram, BASE_URL).toString();
    const formFields = {
      ...(this.loginFormFields || {}),
      login: "",
      password: "",
      securityCode: "",
      cTrustDevice: "off",
      cUserRole: this.loginArea,
      dwd: loginContext.dwd,
      wfaacl: loginContext.wfaacl,
      encses: loginContext.encses,
      nameid: loginContext.nameid,
      duserid: loginContext.duserid,
      "web-data-recid": loginContext.webDataRecid,
      "wfaacl-recid": loginContext.wfaaclRecid,
      "User-Type": loginContext.userType,
      showTracker: loginContext.showTracker,
      displaySecond: loginContext.displaySecond,
      insecure: loginContext.insecure,
      redirectTo: loginContext.redirectTo,
      enc: loginContext.enc,
      BrowserName: this.browserName,
      BrowserVersion: this.browserVersion,
      BrowserPlatform: this.browserPlatform,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
      osName: "Mac",
      brwsInfo: "Chrome",
      subversion: this.browserVersion,
      supported: "true",
      pageused: "Desktop",
      screenWidth: "1440",
      screenHeight: "900"
    };

    const attempts = [
      async () => this.fetchText(destinationUrl),
      async () =>
        this.fetchText(`${destinationUrl}?isPopup=true`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded"
          },
          body: buildFormBody(formFields)
        }),
      async () =>
        this.fetchText(destinationUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded"
          },
          body: buildFormBody(formFields)
        })
    ];

    for (const attempt of attempts) {
      const response = await attempt();
      if (response.ok && /id=["']sessionid["']/i.test(response.text)) {
        return response;
      }
    }

    throw new Error(
      "Skyward login did not open the gradebook page. The district may require an additional login step."
    );
  }

  async refreshGradebookPage(force = false) {
    if (!force && this.session && Date.now() - this.session.fetchedAt < 15000) {
      return this.session;
    }

    if (!this.session) {
      return this.login();
    }

    const response = await this.fetchText(this.destinationProgram, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: buildFormBody({
        nameid: this.session.pageSession.nameid || this.session.loginContext.nameid,
        encses: this.session.pageSession.encses,
        dwd: this.session.pageSession.dwd,
        wfaacl: this.session.pageSession.wfaacl,
        sessionid: this.session.pageSession.sessionId,
        CurrentProgram: this.destinationProgram,
        HomePage: "sepadm01.w",
        BrowserName: this.browserName,
        BrowserVersion: this.browserVersion,
        BrowserPlatform: this.browserPlatform
      })
    });

    if (!response.ok || !/id=["']sessionid["']/i.test(response.text)) {
      return this.login();
    }

    this.session = {
      ...this.session,
      pageSession: parseSessionContext(response.text),
      pageHtml: response.text,
      fetchedAt: Date.now()
    };
    return this.session;
  }

  async requestHttpLoader(program, payload) {
    const session = await this.refreshGradebookPage();
    const filesAdded = session.pageSession.filesAdded
      ? session.pageSession.filesAdded.split(",")
      : [];
    if (!filesAdded.includes("fusion.js")) {
      filesAdded.push("fusion.js");
    }

    const response = await this.fetchText(`httploader.p?file=${program}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        referer: `${BASE_URL}${this.destinationProgram}`,
        origin: "https://student.canyonsdistrict.org"
      },
      body: buildFormBody({
        ...payload,
        ishttp: "true",
        sessionid: session.pageSession.sessionId,
        "javascript.filesAdded": filesAdded.join(","),
        encses: session.pageSession.encses,
        dwd: session.pageSession.dwd,
        wfaacl: session.pageSession.wfaacl,
        requestId: Date.now()
      })
    });

    const parsedResponse = parseHttpLoaderResponse(response.text);
    if (parsedResponse.status === "logout") {
      this.session = null;
      throw new Error("Skyward session expired. Please try again.");
    }

    return parsedResponse;
  }

  async getGradebookSummary(includeAssignments = false) {
    const session = await this.refreshGradebookPage();
    const summary = parseGradebookSummary(session.pageHtml, includeAssignments);
    summary.pageUrl = `${BASE_URL}${this.destinationProgram}`;
    return summary;
  }

  async getCourseAssignments(courseKey) {
    const session = await this.refreshGradebookPage();
    return parseCourseAssignments(session.pageHtml, courseKey);
  }

  async getGradeDetails(courseKey, bucket, termLabel) {
    const session = await this.refreshGradebookPage();
    const link = findGradeLink(session.pageHtml, courseKey, bucket, termLabel);
    const response = await this.requestHttpLoader("sfgradebook001.w", {
      action: "viewGradeInfoDialog",
      gridCount: session.pageSession.gridCount || "1",
      fromHttp: "yes",
      stuId: link.studentId,
      entityId: link.entityId,
      corNumId: link.courseNumberId,
      track: link.track,
      section: link.section,
      gbId: link.gradebookId,
      bucket: link.bucket,
      subjectId: link.subjectId,
      dialogLevel: link.childLevel ? Number.parseInt(link.childLevel, 10) + 1 : 1,
      isEoc: link.isEndOfCourse
    });

    if (response.status !== "success") {
      throw new Error(`Skyward grade details request failed with status: ${response.status}`);
    }

    return parseGradeDetails(response.output, courseKey, link.termLabel, link.bucket);
  }

  async getAssignmentDetails(assignmentId, courseKey) {
    const session = await this.refreshGradebookPage();
    const link = findAssignmentLink(session.pageHtml, assignmentId, courseKey);
    const response = await this.requestHttpLoader("sfdialogs.w", {
      action: "dialog",
      student: link.studentId,
      gbId: link.gradebookId,
      assignId: link.assignmentId,
      eid: link.requestEntityToken,
      type: "assignment"
    });

    if (response.status !== "success") {
      throw new Error(`Skyward assignment details request failed with status: ${response.status}`);
    }

    return parseAssignmentDetails(response.output, assignmentId, link.courseKey);
  }
}

module.exports = {
  SkywardHttpClient,
  DEFAULT_DESTINATION
};
