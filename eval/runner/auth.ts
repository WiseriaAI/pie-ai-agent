import type { BrowserContext } from "playwright";

export interface AuthConfig {
  loginUrl: string;
  usernameField: string;
  passwordField: string;
  username: string;
  password: string;
  /** A substring the post-login URL should contain, OR a selector that appears only when logged in. */
  successUrlContains?: string;
}

/** Log into each configured site in `context` so the session persists for the run.
 *  Throws if a login can't be confirmed (so the orchestrator records harness-error
 *  rather than silently running an unauthenticated task). */
export async function seedAuth(context: BrowserContext, configs: AuthConfig[]): Promise<void> {
  for (const cfg of configs) {
    const page = await context.newPage();
    try {
      await page.goto(cfg.loginUrl, { waitUntil: "domcontentloaded" });
      await page.fill(cfg.usernameField, cfg.username);
      await page.fill(cfg.passwordField, cfg.password);

      // Try clicking the submit button first; fall back to Enter on the password field.
      const submitBtn = await page.$('button[type="submit"], .action-login, #login-form button');
      if (submitBtn) {
        await submitBtn.click();
      } else {
        await page.keyboard.press("Enter");
      }

      await page.waitForLoadState("networkidle");

      // Confirm login succeeded.
      if (cfg.successUrlContains) {
        const currentUrl = page.url();
        if (!currentUrl.includes(cfg.successUrlContains)) {
          // Try navigating to a known post-login URL to confirm the session cookie works.
          throw new Error(
            `[seedAuth] Login to ${cfg.loginUrl} failed: expected URL to contain "${cfg.successUrlContains}" but got "${currentUrl}"`,
          );
        }
      } else {
        // No successUrlContains: check that the login form is gone from the page.
        const loginFieldStillVisible = await page.$(cfg.usernameField);
        if (loginFieldStillVisible) {
          throw new Error(
            `[seedAuth] Login to ${cfg.loginUrl} failed: username field is still visible after submit`,
          );
        }
      }
    } finally {
      await page.close(); // session cookie stays in the context
    }
  }
}
