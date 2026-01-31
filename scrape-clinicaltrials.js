#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Scrape recruiting trials from ClinicalTrials.gov using Firecrawl.
 *
 * Requirements:
 * - FIRECRAWL_API_KEY must be set in the environment.
 * - Node.js 18+ (for built-in fetch).
 *
 * Usage:
 *   node scrape-clinicaltrials.js
 *
 * Optional env:
 *   START_URL=https://clinicaltrials.gov/search?recrs=ab
 *   LIMIT=50
 */

const API_BASE = "https://api.firecrawl.dev/v1";
const API_KEY = process.env.FIRECRAWL_API_KEY;
const START_URL =
  process.env.START_URL || "https://clinicaltrials.gov/search?recrs=ab";
const LIMIT = Number.parseInt(process.env.LIMIT || "50", 10);

if (!API_KEY) {
  console.error("Missing FIRECRAWL_API_KEY env var.");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function firecrawlRequest(path, method, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firecrawl error ${res.status}: ${text}`);
  }
  return res.json();
}

function normalizeText(input) {
  if (!input) return "";
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*•]\s+/, ""));
  return lines.join("; ").replace(/\s+/g, " ").trim();
}

function extractSection(markdown, heading) {
  const headingRegex = new RegExp(
    String.raw`^#{1,4}\s+${heading}\s*$`,
    "im"
  );
  const match = markdown.match(headingRegex);
  if (!match || match.index == null) return "";
  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const nextHeading = rest.search(/^#{1,4}\s+/m);
  const section =
    nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return section.trim();
}

function extractLineValue(markdown, label) {
  const regex = new RegExp(
    String.raw`${label}\s*[:\-]\s*(.+)`,
    "i"
  );
  const match = markdown.match(regex);
  return match ? match[1].trim() : "";
}

function parseEligibility(markdown) {
  const eligibility = extractSection(markdown, "Eligibility Criteria");
  if (!eligibility) {
    return { inclusion: "", exclusion: "", age: "", sex: "" };
  }

  const inclusionMatch = eligibility.match(
    /Inclusion Criteria\s*:\s*([\s\S]*?)(?=\n\s*Exclusion Criteria|$)/i
  );
  const exclusionMatch = eligibility.match(
    /Exclusion Criteria\s*:\s*([\s\S]*?)$/i
  );

  const sex =
    extractLineValue(eligibility, "Sex") ||
    extractLineValue(eligibility, "Gender");
  const minAge = extractLineValue(eligibility, "Minimum Age");
  const maxAge = extractLineValue(eligibility, "Maximum Age");
  const age = normalizeText(
    [minAge && `Minimum Age: ${minAge}`, maxAge && `Maximum Age: ${maxAge}`]
      .filter(Boolean)
      .join("\n")
  );

  return {
    inclusion: normalizeText(inclusionMatch ? inclusionMatch[1] : ""),
    exclusion: normalizeText(exclusionMatch ? exclusionMatch[1] : ""),
    age,
    sex: normalizeText(sex),
  };
}

function parseLocations(markdown) {
  const locationsText =
    extractSection(markdown, "Locations") ||
    extractSection(markdown, "Contacts and Locations");
  if (!locationsText) return [];

  const lines = locationsText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^[-*•]\s*$/.test(line));

  const locations = [];
  for (const line of lines) {
    if (/^(Contact|Phone|Email|Site)\b/i.test(line)) continue;
    const cleaned = line.replace(/^[-*•]\s+/, "");
    const parts = cleaned.split(",").map((part) => part.trim());
    if (parts.length >= 3) {
      locations.push({
        city: parts[0] || "",
        state: parts[1] || "",
        country: parts.slice(2).join(", ") || "",
      });
    } else if (parts.length === 2) {
      locations.push({
        city: parts[0] || "",
        state: parts[1] || "",
        country: "",
      });
    } else if (parts.length === 1) {
      locations.push({
        city: "",
        state: "",
        country: parts[0] || "",
      });
    }
  }
  return locations;
}

function parseTrial(markdown, url) {
  const nctIdMatch = markdown.match(/NCT\d{8}/);
  const nct_id = nctIdMatch ? nctIdMatch[0] : "";

  const titleMatch = markdown.match(/^#{1,4}\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "";

  const conditionSection =
    extractSection(markdown, "Conditions") ||
    extractSection(markdown, "Condition");
  const condition = normalizeText(conditionSection);

  const recruitment_status =
    extractLineValue(markdown, "Recruitment Status") ||
    extractLineValue(markdown, "Overall Status");

  const sponsor =
    extractLineValue(markdown, "Sponsor") ||
    extractLineValue(markdown, "Lead Sponsor");

  const contactInfoText =
    extractSection(markdown, "Contacts and Locations") ||
    extractSection(markdown, "Contacts");
  const contact_info = normalizeText(contactInfoText);

  const eligibility = parseEligibility(markdown);
  const locations = parseLocations(markdown);

  return {
    nct_id,
    title,
    condition,
    recruitment_status: normalizeText(recruitment_status),
    inclusion_criteria: eligibility.inclusion,
    exclusion_criteria: eligibility.exclusion,
    age_requirements: eligibility.age,
    sex: eligibility.sex,
    locations,
    sponsor: normalizeText(sponsor),
    contact_info,
    source_url: url,
  };
}

function isRecruiting(status) {
  return /^(Recruiting|Not yet recruiting)$/i.test(status.trim());
}

async function startCrawl() {
  const crawlBody = {
    url: START_URL,
    limit: LIMIT,
    maxDepth: 2,
    includePaths: ["/study/", "/ct2/show/"],
    excludePaths: ["/api/", "/search/advanced", "/about/", "/study-records/"],
    scrapeOptions: {
      formats: ["markdown"],
      onlyMainContent: true,
    },
  };
  const crawl = await firecrawlRequest("/crawl", "POST", crawlBody);
  if (!crawl || !crawl.id) {
    throw new Error("Unexpected crawl response from Firecrawl.");
  }
  return crawl.id;
}

async function waitForCrawl(jobId) {
  for (;;) {
    const status = await firecrawlRequest(`/crawl/${jobId}`, "GET");
    if (status.status === "completed") return status;
    if (status.status === "failed") {
      throw new Error(`Crawl failed: ${status.error || "Unknown error"}`);
    }
    await sleep(2000);
  }
}

async function scrapeUrl(url) {
  const scrapeBody = {
    url,
    formats: ["markdown"],
    onlyMainContent: true,
  };
  const scraped = await firecrawlRequest("/scrape", "POST", scrapeBody);
  return scraped && scraped.markdown ? scraped.markdown : "";
}

async function main() {
  const jobId = await startCrawl();
  const crawlResult = await waitForCrawl(jobId);
  const pages = crawlResult.data || crawlResult.pages || [];

  const trials = [];
  for (const page of pages) {
    const url = page.url || page.sourceUrl || "";
    if (!url) continue;
    let markdown = page.markdown || page.content || "";
    if (!markdown) {
      markdown = await scrapeUrl(url);
    }
    if (!markdown) continue;
    const trial = parseTrial(markdown, url);
    if (!trial.nct_id) continue;
    if (isRecruiting(trial.recruitment_status)) {
      trials.push(trial);
    }
  }

  console.log(JSON.stringify(trials, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
