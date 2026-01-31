const path = require("path");

const SCRIPT_PATH = path.resolve(
  __dirname,
  "..",
  "scrape-clinicaltrials.js"
);

function createFetchMock(pages) {
  return jest.fn().mockImplementation((url, options) => {
    if (url.endsWith("/crawl") && options && options.method === "POST") {
      return Promise.resolve({
        ok: true,
        json: async () => ({ id: "job-123" }),
      });
    }
    if (url.endsWith("/crawl/job-123") && options && options.method === "GET") {
      return Promise.resolve({
        ok: true,
        json: async () => ({ status: "completed", data: pages }),
      });
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      text: async () => "Not Found",
    });
  });
}

function runScriptWithFetch(fetchMock) {
  jest.resetModules();
  process.env.FIRECRAWL_API_KEY = "test-key";
  global.fetch = fetchMock;

  let resolveOutput;
  const outputPromise = new Promise((resolve) => {
    resolveOutput = resolve;
  });

  const logSpy = jest
    .spyOn(console, "log")
    .mockImplementation((msg) => resolveOutput(msg));
  const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  const exitSpy = jest
    .spyOn(process, "exit")
    .mockImplementation((code) => {
      throw new Error(`process.exit(${code}) called`);
    });

  require(SCRIPT_PATH);

  return outputPromise
    .then((output) => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      exitSpy.mockRestore();
      return output;
    })
    .catch((err) => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      exitSpy.mockRestore();
      throw err;
    });
}

function getRecruitingMarkdown() {
  return `
# Example Trial Title
NCT12345678

## Conditions
- Diabetes
- Hypertension

Recruitment Status: Recruiting

Sponsor: Example Sponsor Inc.

## Eligibility Criteria
Inclusion Criteria:
- Age 18 years or older
- HbA1c < 9.0

Exclusion Criteria:
- Pregnancy
- Severe renal disease

Sex: All
Minimum Age: 18 Years
Maximum Age: 65 Years

## Locations
- Austin, Texas, United States

## Contacts and Locations
Contact: Jane Doe
Phone: 555-555-5555
Email: jane@example.com
`;
}

function getNotRecruitingMarkdown() {
  return `
# Non Recruiting Trial
NCT87654321
## Conditions
Asthma

Recruitment Status: Completed
`;
}

function getMissingFieldsMarkdown() {
  return `
# Minimal Trial
NCT11111111
Recruitment Status: Not yet recruiting
`;
}

describe("ClinicalTrials.gov scraper", () => {
  test("scrapes a recruiting trial and outputs required fields", async () => {
    const pages = [
      {
        url: "https://clinicaltrials.gov/study/NCT12345678",
        markdown: getRecruitingMarkdown(),
      },
    ];
    const output = await runScriptWithFetch(createFetchMock(pages));
    const results = JSON.parse(output);

    expect(results).toHaveLength(1);
    const trial = results[0];

    expect(trial).toMatchObject({
      nct_id: "NCT12345678",
      title: "Example Trial Title",
      condition: "Diabetes; Hypertension",
      recruitment_status: "Recruiting",
      inclusion_criteria: expect.any(String),
      exclusion_criteria: expect.any(String),
      age_requirements: expect.any(String),
      sex: expect.any(String),
      locations: expect.any(Array),
      sponsor: "Example Sponsor Inc.",
      contact_info: expect.any(String),
    });

    expect(trial.inclusion_criteria).toContain("Age 18 years or older");
    expect(trial.exclusion_criteria).toContain("Pregnancy");
    expect(trial.locations[0]).toMatchObject({
      city: "Austin",
      state: "Texas",
      country: "United States",
    });
  });

  test("filters out trials that are not recruiting", async () => {
    const pages = [
      {
        url: "https://clinicaltrials.gov/study/NCT12345678",
        markdown: getRecruitingMarkdown(),
      },
      {
        url: "https://clinicaltrials.gov/study/NCT87654321",
        markdown: getNotRecruitingMarkdown(),
      },
    ];
    const output = await runScriptWithFetch(createFetchMock(pages));
    const results = JSON.parse(output);

    expect(results).toHaveLength(1);
    expect(results[0].nct_id).toBe("NCT12345678");
  });

  test("handles missing fields and preserves schema", async () => {
    const pages = [
      {
        url: "https://clinicaltrials.gov/study/NCT11111111",
        markdown: getMissingFieldsMarkdown(),
      },
    ];
    const output = await runScriptWithFetch(createFetchMock(pages));
    const results = JSON.parse(output);

    expect(results).toHaveLength(1);
    const trial = results[0];

    const requiredKeys = [
      "nct_id",
      "title",
      "condition",
      "recruitment_status",
      "inclusion_criteria",
      "exclusion_criteria",
      "age_requirements",
      "sex",
      "locations",
      "sponsor",
      "contact_info",
    ];
    for (const key of requiredKeys) {
      expect(trial).toHaveProperty(key);
      expect(trial[key]).not.toBeUndefined();
    }

    expect(typeof trial.nct_id).toBe("string");
    expect(typeof trial.title).toBe("string");
    expect(typeof trial.condition).toBe("string");
    expect(typeof trial.recruitment_status).toBe("string");
    expect(typeof trial.inclusion_criteria).toBe("string");
    expect(typeof trial.exclusion_criteria).toBe("string");
    expect(typeof trial.age_requirements).toBe("string");
    expect(typeof trial.sex).toBe("string");
    expect(Array.isArray(trial.locations)).toBe(true);
    expect(typeof trial.sponsor).toBe("string");
    expect(typeof trial.contact_info).toBe("string");
  });

  test("normalizes bullet lists into single-line text", async () => {
    const pages = [
      {
        url: "https://clinicaltrials.gov/study/NCT12345678",
        markdown: getRecruitingMarkdown(),
      },
    ];
    const output = await runScriptWithFetch(createFetchMock(pages));
    const results = JSON.parse(output);
    const trial = results[0];

    expect(trial.inclusion_criteria).toBe(
      "Age 18 years or older; HbA1c < 9.0"
    );
    expect(trial.exclusion_criteria).toBe(
      "Pregnancy; Severe renal disease"
    );
  });
});
