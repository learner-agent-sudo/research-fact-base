import { expect, test, type Page } from "@playwright/test";
import {
  ALLOWED,
  CODE,
  STRANGER,
  expireAllSessions,
  installFakes,
  magicLinkLanding,
  resetWorld,
  world,
} from "./fakes";

const QUESTION = "What is the duty of honest performance?";

test.beforeEach(async ({ page, baseURL }) => {
  resetWorld();
  await installFakes(page, new URL(baseURL!).origin);
});

test.afterEach(() => {
  expect(world.leaked, "requests that would have reached the real internet").toEqual([]);
});

async function signIn(page: Page, email = ALLOWED) {
  await page.goto(magicLinkLanding(email));
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page is wider than the screen").toBeLessThanOrEqual(0);
}

/** The app's own alert (Next.js also renders an empty role="alert" route announcer). */
function alertBox(page: Page) {
  return page.locator('[role="alert"]:not(#__next-route-announcer__)');
}

async function ask(page: Page, question = QUESTION) {
  const box = page.getByPlaceholder("Ask about your documents…");
  await box.fill(question);
  await box.press("Enter");
}

test.describe("sign-in", () => {
  test("site loads under the GitHub Pages path with no broken files or script errors", async ({ page }) => {
    const problems: string[] = [];
    page.on("response", (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()} ${r.url()}`));
    page.on("pageerror", (e) => problems.push(`script error: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));

    await page.goto("./");
    await expect(page.getByRole("heading", { name: "Research Fact Base" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page).toHaveTitle(/Research Fact Base/);
    await expectNoHorizontalScroll(page);
    expect(problems).toEqual([]);
  });

  test("the email link points back to this site, not localhost:3000", async ({ page, baseURL }) => {
    await page.goto("./");
    await page.getByLabel("Email").fill(ALLOWED);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();

    await expect(page.getByText(`Check ${ALLOWED}`)).toBeVisible();
    await expect(page.getByText("use the newest")).toBeVisible();
    expect(world.otpRequests).toHaveLength(1);
    expect(world.otpRequests[0].body.email).toBe(ALLOWED);
    expect(world.otpRequests[0].redirectTo).toBe(baseURL);
  });

  test("clicking the email link signs you in and removes the tokens from the address bar", async ({ page }) => {
    await signIn(page);
    await expect(page.getByPlaceholder("Ask about your documents…")).toBeVisible();
    expect(page.url()).not.toContain("access_token");
    expect(world.apiRequests.map((r) => r.route)).toContain("me");
  });

  test("an expired or already-used link explains what happened and offers a new one", async ({ page }) => {
    // Exactly what Supabase sends back for a reused link (the reported error).
    await page.goto("./#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired&sb=");
    await expect(alertBox(page)).toContainText("expired or was already used");
    await expect(alertBox(page)).toContainText("newest email");
    await expect(page.getByLabel("Email")).toBeVisible();
    expect(page.url()).not.toContain("error");
  });

  test("the code from the email signs you in (e.g. email read on a phone)", async ({ page }) => {
    await page.goto("./");
    await page.getByLabel("Email").fill(ALLOWED);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();

    const codeBox = page.getByLabel("Or, if the email shows a code, enter it here:");
    await codeBox.fill("12");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(alertBox(page)).toContainText("digits only");

    await codeBox.fill("999999");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(alertBox(page)).toContainText("expired or was already used");

    await codeBox.fill(CODE);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByPlaceholder("Ask about your documents…")).toBeVisible();
    expect(world.verifyRequests.at(-1)).toMatchObject({ email: ALLOWED, token: CODE, type: "email" });
  });

  test("Supabase's email rate limit is explained in plain words", async ({ page }) => {
    world.otpError = { status: 429, error_code: "over_email_send_rate_limit", msg: "email rate limit exceeded" };
    await page.goto("./");
    await page.getByLabel("Email").fill(ALLOWED);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(alertBox(page)).toContainText("Too many sign-in emails");
    await expect(page.getByLabel("Email")).toHaveValue(ALLOWED);
  });

  test("the 60-second resend cooldown is explained", async ({ page }) => {
    world.otpError = {
      status: 429,
      error_code: "over_request_rate_limit",
      msg: "For security purposes, you can only request this after 42 seconds.",
    };
    await page.goto("./");
    await page.getByLabel("Email").fill(ALLOWED);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(alertBox(page)).toContainText("wait 42 seconds");
  });

  test("an email that isn't on the allowed list is told so up front, and can sign out", async ({ page }) => {
    await signIn(page, STRANGER);
    await expect(alertBox(page)).toContainText(`${STRANGER} is not on the allowed list`);
    await expect(page.getByPlaceholder("Ask about your documents…")).toHaveCount(0);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByLabel("Email")).toBeVisible();
  });

  test("a server without ALLOWED_EMAILS says exactly which setting is missing", async ({ page }) => {
    delete world.env.ALLOWED_EMAILS;
    await signIn(page);
    await expect(alertBox(page)).toContainText("no ALLOWED_EMAILS configured");
    world.env.ALLOWED_EMAILS = ALLOWED;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByPlaceholder("Ask about your documents…")).toBeVisible();
  });

  test("staying signed in across a reload, and signing out", async ({ page }) => {
    await signIn(page);
    await expect(page.getByPlaceholder("Ask about your documents…")).toBeVisible();
    await page.reload();
    await expect(page.getByPlaceholder("Ask about your documents…")).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByLabel("Email")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Email")).toBeVisible();
  });

  test("the corpus page also requires sign-in", async ({ page }) => {
    await page.goto("./admin/");
    await expect(page.getByLabel("Email")).toBeVisible();
    expect(world.apiRequests.filter((r) => r.route === "documents")).toHaveLength(0);
  });
});

test.describe("research chat", () => {
  test("shows only the checked answer: removed sentences, verified quote, sources", async ({ page }) => {
    await signIn(page);
    await ask(page);

    const answer = page.locator(".answer");
    await expect(answer).toContainText("There is a duty of honest performance (Bhasin v Hrynew, 2014 SCC 71) [S1].");
    // The checker's fabricated citation never reaches the answer itself…
    await expect(answer).not.toContainText("Callow");
    // …it is listed as removed, with the reason.
    const removed = page.getByText("Removed by source checks (1)").locator("..");
    await expect(removed).toContainText("Callow v Zollinger, 2020 SCC 45");
    await expect(page.getByText("✓ verified")).toBeVisible();
    await expect(page.getByText("“a duty of honest performance in contractual dealings”")).toBeVisible();
    await expect(page.getByText("confidence: medium")).toBeVisible();

    await page.getByText("Passages searched (1)").click();
    await page.getByText("Contract Case List 2024.md").click();
    await expect(page.getByRole("link", { name: /Open document in Google Drive/ })).toHaveAttribute(
      "href",
      "https://drive.google.com/file/d/abc123/view",
    );

    // The question went to the API with the session token.
    const chat = world.apiRequests.find((r) => r.route === "chat")!;
    expect(chat.headers.authorization).toMatch(/^Bearer ey/);
    expect(chat.body).toEqual({ messages: [{ role: "user", content: QUESTION }], tier: "free" });
    // Three free drafting models + one checker.
    expect(world.modelCalls).toHaveLength(4);
    await expectNoHorizontalScroll(page);
  });

  test("follow-up questions carry the earlier verified answer as context", async ({ page }) => {
    await signIn(page);
    await ask(page);
    await expect(page.getByText("confidence: medium")).toBeVisible();
    await ask(page, "And when was it decided?");
    await expect(page.getByText("confidence: medium")).toHaveCount(2);

    const second = world.apiRequests.filter((r) => r.route === "chat")[1].body as { messages: { role: string }[] };
    expect(second.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  test("re-run with Claude sends the paid tier", async ({ page }) => {
    await signIn(page);
    await ask(page);
    await page.getByRole("button", { name: "↑ Re-run with Claude (paid)" }).click();
    await expect(page.getByText(/drafted by anthropic\/claude-sonnet-4\.5/)).toBeVisible();
    const last = world.apiRequests.filter((r) => r.route === "chat").at(-1)!;
    expect((last.body as { tier: string }).tier).toBe("paid");
  });

  test("abstains, without asking any AI model, when nothing relevant is found", async ({ page }) => {
    world.rows = [];
    await signIn(page);
    await ask(page, "What is the airspeed of an unladen swallow?");
    await expect(page.locator(".answer")).toContainText("don't contain anything relevant");
    expect(world.modelCalls).toHaveLength(0);
  });

  test("a missing server key is shown as an error, never as an answer", async ({ page }) => {
    delete world.env.OPENROUTER_API_KEY;
    await signIn(page);
    await ask(page);
    await expect(page.getByText(/missing OPENROUTER_API_KEY/)).toBeVisible();
    await expect(page.locator(".answer")).toHaveCount(0);
  });

  test("an expired session is reported instead of failing silently", async ({ page }) => {
    await signIn(page);
    await expect(page.getByPlaceholder("Ask about your documents…")).toBeVisible();
    expireAllSessions();
    await ask(page);
    await expect(page.getByText("Your session has expired. Please sign in again.")).toBeVisible();
  });

  test("the corpus page lists documents and their status", async ({ page }) => {
    await signIn(page);
    await page.getByRole("link", { name: "Corpus" }).click();
    await expect(page).toHaveURL(/\/research-fact-base\/admin\/$/);
    await expect(page.getByText("Contract Case List 2024.md")).toBeVisible();
    await expect(page.getByText("family-law.md")).toBeVisible();
    await expect(page.getByText("1,234")).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole("link", { name: "← chat" }).click();
    await expect(page.getByPlaceholder("Ask about your documents…")).toBeVisible();
  });
});
