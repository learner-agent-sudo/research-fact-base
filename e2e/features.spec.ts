import { expect, test, type Page } from "@playwright/test";
import { ALLOWED, VALID_OPENROUTER_KEY, installFakes, magicLinkLanding, resetWorld, world } from "./fakes";

const BOX = "Ask about your documents…";
const ANSWER = "There is a duty of honest performance (Bhasin v Hrynew, 2014 SCC 71) [S1].";

test.beforeEach(async ({ page, baseURL }) => {
  resetWorld();
  await installFakes(page, new URL(baseURL!).origin);
});

test.afterEach(() => {
  expect(world.leaked, "requests that would have reached the real internet").toEqual([]);
});

async function signIn(page: Page) {
  await page.goto(magicLinkLanding(ALLOWED));
  await expect(page.getByPlaceholder(BOX)).toBeVisible();
}

async function ask(page: Page, question = "What is the duty of honest performance?") {
  await page.getByPlaceholder(BOX).fill(question);
  await page.getByPlaceholder(BOX).press("Enter");
}

const nav = (page: Page, name: "Ask" | "Documents" | "Settings") =>
  page.getByRole("navigation", { name: "Main" }).getByRole("link", { name });

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "page is wider than the screen").toBeLessThanOrEqual(0);
}

/** The app's own alerts (Next.js also renders an empty role="alert" route announcer). */
const alertBox = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

const savedConversations = (page: Page) =>
  page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("rfb.chat.")));

test.describe("conversation", () => {
  test("is still there after visiting other pages, and after a reload", async ({ page }) => {
    await signIn(page);
    await ask(page);
    await expect(page.locator(".answer")).toContainText(ANSWER);

    await nav(page, "Documents").click();
    await expect(page.getByRole("heading", { name: "Your documents" })).toBeVisible();
    await nav(page, "Settings").click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await nav(page, "Ask").click();
    await expect(page.getByText("What is the duty of honest performance?")).toBeVisible();
    await expect(page.locator(".answer")).toContainText(ANSWER);

    await page.reload();
    await expect(page.locator(".answer")).toContainText(ANSWER);
    await expect(page.getByText("confidence: medium")).toBeVisible();
  });

  test("an answer still being prepared keeps arriving while you're on another page", async ({ page }) => {
    world.chatDelayMs = 1500;
    await signIn(page);
    await ask(page);
    await expect(page.getByText("Searching your documents…")).toBeVisible();
    await nav(page, "Documents").click();
    await expect(page.getByTitle("An answer is being prepared")).toBeVisible();
    await expect(page.getByTitle("An answer is being prepared")).toHaveCount(0, { timeout: 10_000 });
    await nav(page, "Ask").click();
    await expect(page.locator(".answer")).toContainText(ANSWER);
    expect(world.apiRequests.filter((r) => r.route === "chat")).toHaveLength(1);
  });

  test("an answer cut off by a reload is marked as interrupted, not left spinning", async ({ page }) => {
    world.chatDelayMs = 5000;
    await signIn(page);
    await ask(page);
    await expect(page.getByText("Searching your documents…")).toBeVisible();
    await page.reload();
    await expect(page.getByText(/This answer was interrupted/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  });

  test("an answer that never arrives is abandoned with a clear message, not left spinning", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __rfbChatLimits: object }).__rfbChatLimits = { stallMs: 2000 };
    });
    world.chatHang = true;
    await signIn(page);
    await ask(page);
    await expect(page.getByText("Searching your documents…")).toBeVisible();
    await expect(page.getByText(/The research service stopped responding/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

    // The next question works normally.
    world.chatHang = false;
    await ask(page, "Try again");
    await expect(page.locator(".answer")).toContainText(ANSWER);
  });

  test("Stop cancels an answer in progress", async ({ page }) => {
    world.chatDelayMs = 10_000;
    await signIn(page);
    await ask(page);
    await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByText("You stopped this answer.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
    await expect(page.getByTitle("An answer is being prepared")).toHaveCount(0);

    await page.reload();
    await expect(page.getByText("You stopped this answer.")).toBeVisible();
  });

  test("an answer cut short is reported, not shown as finished", async ({ page }) => {
    world.chatTruncate = true;
    await signIn(page);
    await ask(page);
    await expect(page.getByText("The answer stopped before it finished. Please ask again.")).toBeVisible();
    await expect(page.locator(".answer")).toHaveCount(0);
  });

  test("when the AI models are too slow, the server's time limit message is shown", async ({ page }) => {
    world.env.TIME_LIMIT_MS = "1500";
    world.modelDelayMs.check = 60_000;
    await signIn(page);
    await ask(page);
    await expect(page.getByText(/didn't finish within 2 seconds/)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/switch to Paid for this question/)).toBeVisible();
    await expect(page.locator(".answer")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  });

  test("New conversation starts afresh, and follow-ups don't carry the old one", async ({ page }) => {
    await signIn(page);
    await ask(page);
    await expect(page.locator(".answer")).toContainText(ANSWER);
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.getByRole("heading", { name: "Ask a question about your documents" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Ask a question about your documents" })).toBeVisible();

    await ask(page, "Second question");
    await expect(page.locator(".answer")).toHaveCount(1);
    const last = world.apiRequests.filter((r) => r.route === "chat").at(-1)!.body as { messages: unknown[] };
    expect(last.messages).toHaveLength(1);
  });

  test("signing out deletes the saved conversation from this device", async ({ page }) => {
    await signIn(page);
    await ask(page);
    await expect(page.locator(".answer")).toContainText(ANSWER);
    expect(await savedConversations(page)).toHaveLength(1);

    await nav(page, "Settings").click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByLabel("Email")).toBeVisible();
    expect(await savedConversations(page)).toEqual([]);

    await page.goto("about:blank");
    await signIn(page);
    await expect(page.getByRole("heading", { name: "Ask a question about your documents" })).toBeVisible();
  });
});

test.describe("appearance", () => {
  const isDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains("dark"));

  test("dark mode switches on, survives a reload, and 'Match my device' follows the device", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await signIn(page);
    await nav(page, "Settings").click();
    expect(await isDark(page)).toBe(false);

    await page.getByText("Dark", { exact: true }).click();
    expect(await isDark(page)).toBe(true);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg, "page background turns dark").not.toMatch(/oklch\(0\.9|rgb\(25[0-5]/);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    expect(await isDark(page)).toBe(true);

    await page.getByText("Light", { exact: true }).click();
    expect(await isDark(page)).toBe(false);

    await page.getByText("Match my device").click();
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => isDark(page)).toBe(true);
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => isDark(page)).toBe(false);
  });

  test("the sign-in page also follows the saved theme", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("rfb.theme", "dark"));
    await page.goto("./");
    await expect(page.getByLabel("Email")).toBeVisible();
    expect(await isDark(page)).toBe(true);
  });
});

test.describe("settings", () => {
  const FREE = { prompt: "0", completion: "0" };

  test("AI choices are saved for everyone and used by the next answer", async ({ page }) => {
    world.catalog = [
      { id: "acme/lawyer-llm:free", name: "Acme: Lawyer LLM (free)", pricing: FREE, context_length: 131072 },
      { id: "acme/checker-llm:free", name: "Acme: Checker LLM (free)", pricing: FREE, context_length: 131072 },
      { id: "deepseek/deepseek-chat-v3.1:free", name: "DeepSeek V3.1 (free)", pricing: FREE, context_length: 163840 },
      { id: "openai/gpt-5", name: "OpenAI: GPT-5", pricing: { prompt: "0.00001", completion: "0.00003" }, context_length: 400000 },
    ];
    await signIn(page);
    await nav(page, "Settings").click();

    await page.getByLabel("Drafting models per question (Free mode)").selectOption("2");
    await page.getByLabel("Passages searched per question").selectOption("6");
    await page.getByText("Let me choose").click();
    await page.getByLabel("Drafting model 1").selectOption("acme/lawyer-llm:free");
    await page.getByLabel("Checking model").selectOption("acme/checker-llm:free");
    await page.getByLabel("Paid model").selectOption("openai/gpt-5");
    await page.getByRole("button", { name: "Save AI settings" }).click();
    await expect(page.getByRole("status")).toContainText("Saved");

    expect(world.appSettings.ai).toEqual({
      defaultTier: "free",
      fanout: 2,
      topK: 6,
      freeModels: ["acme/lawyer-llm:free"],
      freeChecker: "acme/checker-llm:free",
      paidModel: "openai/gpt-5",
    });
    await expect(page.getByText(/Currently drafting with acme\/lawyer-llm:free, deepseek/)).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Drafting models per question (Free mode)")).toHaveValue("2");
    await expect(page.getByLabel("Drafting model 1")).toHaveValue("acme/lawyer-llm:free");
    await expect(page.getByLabel("Paid model")).toHaveValue("openai/gpt-5");

    await nav(page, "Ask").click();
    await ask(page);
    await expect(page.locator(".answer")).toContainText(ANSWER);
    expect(world.modelCalls).toEqual(["acme/lawyer-llm:free", "deepseek/deepseek-chat-v3.1:free", "acme/checker-llm:free"]);
    await expectNoHorizontalScroll(page);
  });

  test("the default answer mode chosen in Settings is used on the Ask page", async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole("button", { name: "Free", pressed: true })).toBeVisible();
    await nav(page, "Settings").click();
    await page.getByLabel("Default answer mode").selectOption("paid");
    await page.getByRole("button", { name: "Save AI settings" }).click();
    await expect(page.getByRole("status")).toContainText("Saved");
    await nav(page, "Ask").click();
    await expect(page.getByRole("button", { name: "Paid", pressed: true })).toBeVisible();
    await ask(page);
    await expect(page.locator(".answer")).toContainText(ANSWER);
    expect((world.apiRequests.find((r) => r.route === "chat")!.body as { tier: string }).tier).toBe("paid");
  });

  test("an API key is tested before saving, shown only by its last 4 characters, used, and removable", async ({ page }) => {
    await signIn(page);
    await nav(page, "Settings").click();
    const status = page.getByTestId("openrouter-status");
    await expect(status).toContainText("Using the key from your Supabase secrets");

    const field = page.getByLabel("New OpenRouter key");
    await field.fill("sk-or-v1-this-key-is-wrong-0000");
    await page.getByRole("button", { name: "Save key" }).first().click();
    await expect(alertBox(page)).toContainText("OpenRouter rejected this key");
    expect(world.vault).toEqual({});

    await field.fill(VALID_OPENROUTER_KEY);
    await page.getByRole("button", { name: "Save key" }).first().click();
    await expect(page.getByRole("status")).toContainText("Key tested and saved");
    await expect(status).toContainText("Using the key saved here (••••4321)");
    await expect(field).toHaveValue("");
    expect(await page.content()).not.toContain(VALID_OPENROUTER_KEY);
    expect(world.vault).toEqual({ rfb_openrouter_api_key: VALID_OPENROUTER_KEY });

    await nav(page, "Ask").click();
    await ask(page);
    await expect(page.locator(".answer")).toContainText(ANSWER);
    expect(new Set(world.modelKeys)).toEqual(new Set([`Bearer ${VALID_OPENROUTER_KEY}`]));

    await nav(page, "Settings").click();
    await page.getByRole("button", { name: "Remove" }).click();
    await expect(status).toContainText("Using the key from your Supabase secrets");
    expect(world.vault).toEqual({});
  });

  test("a missing key is flagged plainly", async ({ page }) => {
    delete world.env.GEMINI_API_KEY;
    await signIn(page);
    await nav(page, "Settings").click();
    await expect(page.getByTestId("gemini-status")).toContainText("Not set");
    await expectNoHorizontalScroll(page);
  });

  test("when the model list is unavailable, models are chosen automatically", async ({ page }) => {
    await signIn(page);
    await nav(page, "Settings").click();
    await expect(page.getByText(/list of models isn.t available right now/)).toBeVisible();
    await expect(page.getByLabel("Let me choose")).toBeDisabled();
  });
});

test.describe("documents page", () => {
  test("explains how to add sources, links the Drive folder, and shows the last load", async ({ page }) => {
    world.appSettings.library = { folderId: "folder123", finishedAt: "2026-10-12T09:04:00Z", loaded: 2, removed: 1 };
    await signIn(page);
    await nav(page, "Documents").click();

    await expect(page.getByRole("heading", { name: "How to add more sources" })).toBeVisible();
    await expect(page.getByRole("link", { name: "open the folder ↗" })).toHaveAttribute(
      "href",
      "https://drive.google.com/drive/folders/folder123",
    );
    await expect(page.getByRole("link", { name: "Open the loader on GitHub ↗" })).toHaveAttribute(
      "href",
      /\/actions\/workflows\/ingest\.yml$/,
    );
    await expect(page.getByText(/Last checked for new or changed files: .* 2 added or updated, 1 removed/)).toBeVisible();
    await expect(page.getByText("1 ready to search")).toBeVisible();
    await expect(page.getByText("1 still loading")).toBeVisible();
    await expect(page.getByText("1 couldn't be read")).toBeVisible();
    await expect(page.getByText(/probably a scanned PDF/)).toBeVisible();

    await page.getByLabel("Find a document").fill("family");
    await expect(page.getByText("family-law.md")).toBeVisible();
    await expect(page.getByText("Contract Case List 2024.md")).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });

  test("the old Corpus address goes to Documents", async ({ page }) => {
    await signIn(page);
    await page.goto("./admin/");
    await expect(page).toHaveURL(/\/documents\/$/);
    await expect(page.getByRole("heading", { name: "Your documents" })).toBeVisible();
  });
});
