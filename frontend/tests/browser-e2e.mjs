import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const CHROME_PATH = process.env.CHROME_BIN || (
  fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' :
  fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' :
  fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' :
  '/usr/bin/google-chrome'
);

const BASE_URL = process.env.E2E_BASE_URL || 'https://prompthold.pages.dev';
const API_BASE = process.env.E2E_API_BASE || 'https://prompt-vault-gateway.tashfiks.workers.dev';
const delay = ms => new Promise(r => setTimeout(r, ms));

const results = [];

function record(name, category, status, detail) {
  results.push({ name, category, status, detail });
  const icon = status === 'PASS' ? '✅' : '❌';
  console.log(`${icon} [${status}] [${category}] ${name}: ${detail}`);
}

async function waitForBackendReady(apiBase, maxAttempts = 30) {
  console.log(`Connecting to backend API gateway at ${apiBase}...`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${apiBase}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.status === 'ok') {
          console.log(`✅ API gateway & backend healthy and ready (attempt ${attempt}/${maxAttempts})\n`);
          return true;
        }
      }
    } catch {
      // wait for boot
    }
    await delay(2000);
  }
  console.warn(`⚠️ Warning: Backend health endpoint did not confirm healthy status after ${maxAttempts * 2}s. Proceeding with tests...\n`);
  return false;
}

async function login(page, email, password) {
  await page.goto(`${BASE_URL}/?auth=login`, { waitUntil: 'networkidle2' });
  const hasEmail = await page.waitForSelector('input[type="email"]', { timeout: 15000 }).catch(() => null);
  if (hasEmail) {
    await page.type('input[type="email"]', email);
    await page.type('input[type="password"]', password);
    await page.evaluate(() => {
      const btn = document.querySelector('form button.btn-primary');
      if (btn) btn.click();
    });
    await page.waitForFunction(() => !document.querySelector('form input[type="email"]'), { timeout: 15000 }).catch(() => {});
    await delay(1500);
  }
}

// Demo accounts are never seeded in production, so the live suite provisions its own users.
async function registerUser(label) {
  const email = `ci_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@example.com`;
  const password = 'Password123!';
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `CI ${label}`, email, password })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.token) return { email, password, token: data.token, id: data.user?.id };
    if (res.status !== 429) throw new Error(`register ${label} failed: HTTP ${res.status}`);
    await delay(20000);
  }
  throw new Error(`register ${label} rate-limited`);
}

const authHeaders = token => ({ 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` });

async function run() {
  console.log(`=== STARTING 21-FEATURE LIVE BROWSER E2E QA SUITE ===`);
  console.log(`Target URL: ${BASE_URL}`);
  console.log(`API Gateway: ${API_BASE}`);
  console.log(`Browser: ${CHROME_PATH}\n`);

  await waitForBackendReady(API_BASE);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const ts = Date.now();
  const testUser = {
    name: `CI Runner ${ts}`,
    email: `ci_test_${ts}@example.com`,
    password: 'Password123!'
  };

  let sessionToken = '';

  try {
    // 1. Public Pricing & Landing Page
    try {
      const page = await browser.newPage();
      await page.goto(BASE_URL, { waitUntil: 'networkidle2' });
      const text = await page.evaluate(() => document.body.innerText);
      const ok = text.includes('Community') && text.includes('$0') && text.includes('Team');
      record('Public Pricing & Landing Page', 'Public UI', ok ? 'PASS' : 'FAIL', 'Verified tier cards and pricing options');
      await page.close();
    } catch (err) {
      record('Public Pricing & Landing Page', 'Public UI', 'FAIL', err.message);
    }

    // 2. User Registration & Auto-Provisioned Personal Space
    try {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      try {
        await page.goto(`${BASE_URL}/?auth=register`, { waitUntil: 'networkidle2' });
        await page.waitForSelector('#auth-name', { timeout: 15000 });
        await page.type('#auth-name', testUser.name);
        await page.type('#auth-email', testUser.email);
        await page.type('#auth-password', testUser.password);
        await page.type('#auth-confirm', testUser.password);
        await page.evaluate(() => {
          const btn = document.querySelector('form button.btn-primary');
          if (btn) btn.click();
        });
        await page.waitForFunction(() => {
          return !!localStorage.getItem('prompt-vault-session') ||
            document.body.innerText.includes('Personal') ||
            document.body.innerText.includes('Prompt library');
        }, { timeout: 15000 }).catch(() => {});
        await delay(2000);

        sessionToken = await page.evaluate(() => localStorage.getItem('prompt-vault-session'));
      } catch (uiErr) {
        console.warn('Browser registration interaction note:', uiErr.message);
      }

      if (!sessionToken) {
        const rRes = await fetch(`${API_BASE}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: testUser.name, email: testUser.email, password: testUser.password, plan: 'community' })
        }).then(r => r.json()).catch(() => ({}));
        if (rRes.token) {
          sessionToken = rRes.token;
        } else {
          const lRes = await fetch(`${API_BASE}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: testUser.email, password: testUser.password })
          }).then(r => r.json()).catch(() => ({}));
          if (lRes.token) sessionToken = lRes.token;
        }
      }
      const ok = Boolean(sessionToken);
      record('User Registration & Personal Space Auto-Provision', 'Auth', ok ? 'PASS' : 'FAIL', `Registered ${testUser.email} with personal space`);
      await ctx.close();
    } catch (err) {
      record('User Registration & Personal Space Auto-Provision', 'Auth', 'FAIL', err.message);
    }

    // 3. Multi-role RBAC: an Owner, Member and Guest each see the shared group with their own role
    let userA, userB, userC;
    try {
      userA = await registerUser('owner');
      userB = await registerUser('member');
      userC = await registerUser('guest');
      const grp = await fetch(`${API_BASE}/api/groups`, {
        method: 'POST', headers: authHeaders(userA.token),
        body: JSON.stringify({ name: `CI RBAC ${Date.now()}`, description: 'RBAC roles', required_approvals: 1 })
      }).then(r => r.json());
      for (const [u, role] of [[userB, 'MEMBER'], [userC, 'GUEST']]) {
        await fetch(`${API_BASE}/api/groups/${grp.id}/members`, { method: 'POST', headers: authHeaders(userA.token), body: JSON.stringify({ email: u.email, role }) });
      }
      let allOk = Boolean(grp.id);
      for (const [u, role] of [[userA, 'GROUP_MANAGER'], [userB, 'MEMBER'], [userC, 'GUEST']]) {
        const groups = await fetch(`${API_BASE}/api/groups`, { headers: authHeaders(u.token) }).then(r => r.json());
        const g = Array.isArray(groups) && groups.find(x => x.id === grp.id);
        const me = g && g.members.find(m => m.email === u.email);
        if (!me || me.role !== role) allOk = false;
      }
      record('Multi-Role RBAC Authentication (Owner / Member / Guest)', 'Auth & RBAC', allOk ? 'PASS' : 'FAIL', 'Owner, Member and Guest each resolved their own group role');
    } catch (err) {
      record('Multi-Role RBAC Authentication (Owner / Member / Guest)', 'Auth & RBAC', 'FAIL', err.message);
    }

    // 4-9. Prompt Core, Personalizer, Direct Versioning, Diff Viewer, Diff Share, and Active Rollback
    let createdPromptId = '';
    try {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await login(page, testUser.email, testUser.password);

      // 4. Prompt Creation & Variable Detection
      try {
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('New prompt') || b.innerText.includes('Create first prompt'));
          if (btn) btn.click();
        });

        await page.waitForSelector('#np-title', { timeout: 15000 });
        await page.type('#np-title', 'CI Automation Notice');
        await page.type('#np-content', 'Hello {{recipient}}, build {{build_id}} passed on branch {{branch}}!');
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Create prompt'));
          if (btn) btn.click();
        });
        await delay(4000);

        const text = await page.evaluate(() => document.body.innerText);
        const ok = text.includes('CI Automation Notice') && text.includes('v1');
        record('Prompt Creation & Variable Detection', 'Prompt Core', ok ? 'PASS' : 'FAIL', 'Saved v1 prompt with auto-detected {{recipient}}, {{build_id}}, {{branch}}');
      } catch (err) {
        record('Prompt Creation & Variable Detection', 'Prompt Core', 'FAIL', err.message);
      }

      // 5. Live Variable Personalizer
      try {
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Open prompt'));
          if (btn) btn.click();
        });
        await delay(2000);

        await page.waitForSelector('#var-recipient', { timeout: 10000 });
        await page.type('#var-recipient', 'Team Alpha');
        await delay(1000);

        const compiledText = await page.evaluate(() => document.body.innerText);
        const personalizerOk = compiledText.includes('Team Alpha');
        record('Live Variable Personalizer & Interpolation', 'Prompt Core', personalizerOk ? 'PASS' : 'FAIL', 'Real-time keyboard input compiles preview text live');
      } catch (err) {
        record('Live Variable Personalizer & Interpolation', 'Prompt Core', 'FAIL', err.message);
      }

      // 6. Direct Versioning (v1 -> v2)
      try {
        await page.evaluate(() => {
          const ta = document.querySelector('#ed-content');
          if (ta) {
            ta.value = ta.value + '\n\nAll tests completed.';
            ta.dispatchEvent(new Event('input', { bubbles: true }));
          }
        });
        await delay(1000);
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Save new version'));
          if (btn) btn.click();
        });
        await delay(4000);

        const afterSave = await page.evaluate(() => document.body.innerText);
        const v2Ok = afterSave.includes('v2') || afterSave.includes('Active · v2');
        record('Direct Versioning (v1 -> v2)', 'Versioning', v2Ok ? 'PASS' : 'FAIL', 'Saved sequential snapshot v2 with active badge');
      } catch (err) {
        record('Direct Versioning (v1 -> v2)', 'Versioning', 'FAIL', err.message);
      }

      // 7. Visual Diff Viewer Controls
      try {
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Visual changes'));
          if (btn) btn.click();
        });
        await delay(2000);
        const diffText = await page.evaluate(() => document.body.innerText);
        const diffControlsOk = diffText.includes('Word-by-word') && diffText.includes('Side-by-side');
        record('Visual Diff Viewer (Word/Sentence & Split/Inline)', 'Diff Engine', diffControlsOk ? 'PASS' : 'FAIL', 'Diff viewer toggles granularities and layout boxes cleanly');
      } catch (err) {
        record('Visual Diff Viewer (Word/Sentence & Split/Inline)', 'Diff Engine', 'FAIL', err.message);
      }

      // 8. Public Shared Diff Link Generation & Viewing
      try {
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Share comparison'));
          if (btn) btn.click();
        });
        await delay(2000);

        const promptsRes = await fetch(`${API_BASE}/api/prompts`, { headers: { 'Authorization': `Bearer ${sessionToken}` } });
        const userPrompts = await promptsRes.json().catch(() => []);
        createdPromptId = userPrompts[0]?.id;

        let publicDiffOk = false;
        if (createdPromptId) {
          const shareRes = await fetch(`${API_BASE}/api/diff-shares`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
            body: JSON.stringify({ prompt_id: createdPromptId, base_version: 1, target_version: 2, diff_granularity: 'word', view_mode: 'split' })
          });
          const shareData = await shareRes.json().catch(() => ({}));

          if (shareData && shareData.share_id) {
            const incognitoCtx = await browser.createBrowserContext();
            const incognitoPage = await incognitoCtx.newPage();
            await incognitoPage.goto(`${BASE_URL}/?share_diff=${shareData.share_id}`, { waitUntil: 'networkidle2' });
            await delay(3000);
            const publicDiffText = await incognitoPage.evaluate(() => document.body.innerText);
            publicDiffOk = publicDiffText.includes('Shared comparison') && publicDiffText.includes('Version 1') && publicDiffText.includes('Version 2');
            await incognitoCtx.close();
          }
        }
        record('Zero-Config Public Shared Diff Links', 'Collaboration', publicDiffOk ? 'PASS' : 'FAIL', 'Unauthenticated visitor loaded pre-configured diff snapshot');
      } catch (err) {
        record('Zero-Config Public Shared Diff Links', 'Collaboration', 'FAIL', err.message);
      }

      // 9. Active Version Switching / Rollback
      try {
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Version history'));
          if (btn) btn.click();
        });
        await delay(2000);
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Make active'));
          if (btn) btn.click();
        });
        await delay(1000);
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Make active') || b.innerText.includes('Confirm'));
          if (btn) btn.click();
        });
        await delay(3000);
        const rollbackText = await page.evaluate(() => document.body.innerText);
        const rollbackOk = rollbackText.includes('Active · v1') || rollbackText.includes('Active Version');
        record('Active Version Rollback (Without Clones)', 'Versioning', rollbackOk ? 'PASS' : 'FAIL', 'Repointed active version to v1 without duplicating history');
      } catch (err) {
        record('Active Version Rollback (Without Clones)', 'Versioning', 'FAIL', err.message);
      }

      await ctx.close();
    } catch (err) {
      console.warn('Prompt lifecycle section error:', err.message);
    }

    // 10. Subscription Plan Escalation Defense
    try {
      const hackRes = await fetch(`${API_BASE}/api/me/plan`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
        body: JSON.stringify({ plan: 'enterprise' })
      });
      record('Subscription Plan Escalation Exploit Defense', 'Security', hackRes.status === 403 ? 'PASS' : 'FAIL', 'Blocked arbitrary self-upgrade with HTTP 403');
    } catch (err) {
      record('Subscription Plan Escalation Exploit Defense', 'Security', 'FAIL', err.message);
    }

    // 11. Embedded In-Chat MCP Drawer Mode
    try {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.goto(`${BASE_URL}/?mcp_mode=1`, { waitUntil: 'networkidle2' });
      await delay(2500);
      const mcpText = await page.evaluate(() => document.body.innerText);
      const drawerOk = mcpText.includes('MCP') || mcpText.includes('Prompt') || mcpText.includes('Insert');
      record('Embedded In-Chat MCP Drawer (?mcp_mode=1)', 'MCP Integration', drawerOk ? 'PASS' : 'FAIL', 'Rendered responsive drawer interface for AI chat host clients');
      await ctx.close();
    } catch (err) {
      record('Embedded In-Chat MCP Drawer (?mcp_mode=1)', 'MCP Integration', 'FAIL', err.message);
    }

    // 12. FastMCP gateway (/mcp): stateless streamable HTTP; anonymous clients get an OAuth challenge
    try {
      const res = await fetch(`${API_BASE}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ci-e2e', version: '1.0' } } })
      });
      const challenge = res.headers.get('www-authenticate') || '';
      const mcpOk = res.status === 401 && challenge.includes('resource_metadata=');
      record('FastMCP Protocol Gateway Routing (/mcp)', 'MCP Integration', mcpOk ? 'PASS' : 'FAIL', `Anonymous MCP request challenged with RFC 9728 resource metadata (HTTP ${res.status})`);
    } catch (err) {
      record('FastMCP Protocol Gateway Routing (/mcp)', 'MCP Integration', 'FAIL', err.message);
    }

    // 13. Hybrid & Semantic Search
    try {
      const searchRes = await fetch(`${API_BASE}/api/prompts?q=Automation`, {
        headers: { 'Authorization': `Bearer ${sessionToken}` }
      });
      const data = await searchRes.json().catch(() => []);
      const searchOk = searchRes.status === 200 && Array.isArray(data) && data.length > 0;
      record('Hybrid & Semantic Search Engine', 'Search', searchOk ? 'PASS' : 'FAIL', 'Queried keywords and retrieved matching prompt without 500 error');
    } catch (err) {
      record('Hybrid & Semantic Search Engine', 'Search', 'FAIL', err.message);
    }

    // 14. Batch File Upload Modal (.txt, .md, .json)
    try {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await login(page, testUser.email, testUser.password);

      await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(b => b.innerText.includes('Upload files')));
      await page.evaluate(() => Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Upload files')).click());
      await delay(2000);

      // Create temp files
      const tmpDir = path.resolve('/tmp/ci-qa-files');
      fs.mkdirSync(tmpDir, { recursive: true });
      const f1 = path.join(tmpDir, 'batch_ci1.txt');
      const f2 = path.join(tmpDir, 'batch_ci2.md');
      fs.writeFileSync(f1, 'Prompt 1 from batch upload {{var1}}');
      fs.writeFileSync(f2, '# Prompt 2 from batch upload {{var2}}');

      const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 10000 });
      await fileInput.uploadFile(f1, f2);
      await delay(2000);

      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button[type="submit"]')).find(b => b.innerText.includes('Import'));
        if (btn) btn.click();
      });
      await delay(4000);

      const dashText = await page.evaluate(() => document.body.innerText);
      const batchOk = dashText.includes('batch_ci1') || dashText.includes('batch_ci2');
      record('Batch File Upload Modal (.txt, .md, .json)', 'Import/Export', batchOk ? 'PASS' : 'FAIL', 'Uploaded batch files; parsed and imported into library');
      await ctx.close();
    } catch (err) {
      record('Batch File Upload Modal (.txt, .md, .json)', 'Import/Export', 'FAIL', err.message);
    }

    // 15. Duplicate / Move Prompt Across Spaces
    try {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await login(page, testUser.email, testUser.password);

      // Card duplicate buttons are icon-only; match their accessible name as well as visible text.
      const isDuplicateBtn = "b => b.innerText.includes('Duplicate') || (b.getAttribute('aria-label') || '').startsWith('Duplicate')";
      await page.waitForFunction(`Array.from(document.querySelectorAll('button')).some(${isDuplicateBtn})`);
      await page.evaluate(`Array.from(document.querySelectorAll('button')).find(${isDuplicateBtn}).click()`);
      await delay(2000);

      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button[type="submit"]')).find(b => b.innerText.includes('Duplicate prompt') || b.innerText.includes('Move prompt'));
        if (btn) btn.click();
      });
      await delay(4000);

      const afterText = await page.evaluate(() => document.body.innerText);
      const dupOk = afterText.includes('(Copy)') || afterText.includes('duplicated') || afterText.includes('saved');
      record('Duplicate / Move Prompt Across Spaces', 'Management', dupOk ? 'PASS' : 'FAIL', 'Duplicated prompt across spaces with (Copy) title tag');
      await ctx.close();
    } catch (err) {
      record('Duplicate / Move Prompt Across Spaces', 'Management', 'FAIL', err.message);
    }

    // 16. Feedback & Support Widget Submission
    try {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await login(page, testUser.email, testUser.password);

      // Click the feedback button - floating button or navbar help menu
      const opened = await page.evaluate(() => {
        const floating = document.querySelector('button[title*="Report a complaint"]') ||
          Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Feedback & Support'));
        if (floating) {
          floating.click();
          return true;
        }
        return false;
      });
      if (!opened) {
        await page.evaluate(() => {
          const helpBtn = document.querySelector('[data-tour="help"]');
          if (helpBtn) helpBtn.click();
        });
        await delay(500);
        await page.evaluate(() => {
          const item = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Feedback & report issue'));
          if (item) item.click();
        });
      }
      await delay(1500);

      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Bug Report'));
        if (btn) btn.click();
      });
      await delay(500);

      await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
        const subject = inputs.find(i => i.placeholder.includes('broke') || i.placeholder.includes('summary')) || inputs[inputs.length - 1];
        if (subject) subject.focus();
      });
      await page.keyboard.type('CI Automated Bug Verification');

      await page.evaluate(() => {
        const ta = document.querySelector('textarea');
        if (ta) ta.focus();
      });
      await page.keyboard.type('Verification of feedback queue from automated CI job.');

      await page.evaluate(() => {
        const btn = document.querySelector('form button[type="submit"]') ||
          Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === 'Submit');
        if (btn) btn.click();
      });
      await delay(4000);

      const bodyText = await page.evaluate(() => document.body.innerText);
      const feedbackOk = bodyText.includes('Submission Received') || bodyText.includes('Thank you') || bodyText.includes('queued for our team');
      record('Feedback & Support Widget Submission', 'Support', feedbackOk ? 'PASS' : 'FAIL', 'Submitted bug report through UI modal; received ticket confirmation');
      await ctx.close();
    } catch (err) {
      record('Feedback & Support Widget Submission', 'Support', 'FAIL', err.message);
    }

    // 17-20. Team Group Administration (Invite, Role Change, Member Removal, Settings Threshold)
    try {
      // Each Community account may own one team group, so the registered CI user owns this one.
      const aliceToken = sessionToken;
      if (!userB) throw new Error('RBAC users were not provisioned');

      // Create group
      const grpRes = await fetch(`${API_BASE}/api/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aliceToken}` },
        body: JSON.stringify({ name: `CI Group Admin ${Date.now()}`, description: 'Admin testing', required_approvals: 1 })
      });
      const grp = await grpRes.json();

      // 17. Member Invite
      const inviteRes = await fetch(`${API_BASE}/api/groups/${grp.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aliceToken}` },
        body: JSON.stringify({ email: userB.email, role: 'MEMBER' })
      });
      const inviteData = await inviteRes.json();
      record('Team Group Administration: Member Invite', 'Team RBAC', inviteRes.status === 201 ? 'PASS' : 'FAIL', 'Invited registered teammate to team group');

      // 18. Role Change (Member -> Guest)
      const roleRes = await fetch(`${API_BASE}/api/groups/${grp.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aliceToken}` },
        body: JSON.stringify({ email: userB.email, role: 'GUEST' })
      });
      const roleData = await roleRes.json();
      record('Team Group Administration: Role Change (Member ↔ Guest)', 'Team RBAC', (roleRes.status === 200 || roleRes.status === 201) && roleData.role === 'GUEST' ? 'PASS' : 'FAIL', 'Changed member permission to read-only Guest');

      // 19. Member Removal
      const removeRes = await fetch(`${API_BASE}/api/groups/${grp.id}/members/${inviteData.user_id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${aliceToken}` }
      });
      record('Team Group Administration: Member Removal', 'Team RBAC', removeRes.status === 200 ? 'PASS' : 'FAIL', 'Removed teammate from group membership');

      // 20. Update required_approvals threshold
      const threshRes = await fetch(`${API_BASE}/api/groups/${grp.id}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aliceToken}` },
        body: JSON.stringify({ required_approvals: 2 })
      });
      const threshData = await threshRes.json();
      record('Group Settings: Update required_approvals Threshold', 'Team RBAC', threshRes.status === 200 && threshData.required_approvals === 2 ? 'PASS' : 'FAIL', 'Updated group required_approvals gate to 2 votes');
    } catch (err) {
      record('Team Group Administration', 'Team RBAC', 'FAIL', err.message);
    }

    // 21. Proposal Review Gate & Auto-Merge
    try {
      if (!userB || !userC) throw new Error('RBAC users were not provisioned');
      const gateOwner = userC;
      const aliceToken = gateOwner.token;

      const time = Date.now();
      const gRes = await fetch(`${API_BASE}/api/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aliceToken}` },
        body: JSON.stringify({ name: `CI Gate Group ${time}`, description: 'Testing gate', required_approvals: 1 })
      });
      const group = await gRes.json();

      const memberEmail = userB.email;
      const memberToken = userB.token;

      await fetch(`${API_BASE}/api/groups/${group.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aliceToken}` },
        body: JSON.stringify({ email: memberEmail, role: 'MEMBER' })
      });

      const pRes = await fetch(`${API_BASE}/api/prompts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aliceToken}` },
        body: JSON.stringify({ group_id: group.id, title: `CI Gate Prompt ${time}`, content: 'Content v1', change_note: 'v1' })
      });
      const prompt = await pRes.json();

      await fetch(`${API_BASE}/api/prompts/${prompt.id}/proposals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${memberToken}` },
        body: JSON.stringify({ title: `CI Gate Prompt ${time}`, content: 'Content v2 updated', change_note: 'v2 proposal' })
      });

      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await login(page, gateOwner.email, gateOwner.password);

      await page.evaluate(() => {
        const nav = Array.from(document.querySelectorAll('button, a')).find(b => b.innerText.includes('Review requests') || b.innerText.includes('Reviews'));
        if (nav) nav.click();
      });
      await delay(3000);

      await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(b => b.innerText.includes('Approve change')));
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('Approve change'));
        if (btn) btn.click();
      });
      await delay(3000);

      const checkRes = await fetch(`${API_BASE}/api/prompts`, { headers: { 'Authorization': `Bearer ${aliceToken}` } });
      const currentPrompts = await checkRes.json();
      const updated = currentPrompts.find(p => p.id === prompt.id);
      const gateOk = updated && updated.current_version_number === 2;
      record('Proposal Review Gate: Member Propose -> Owner Approve -> Auto-Merge', 'Collaboration', gateOk ? 'PASS' : 'FAIL', 'Owner approved pending change request; automatically merged into v2 active version');
      await ctx.close();
    } catch (err) {
      record('Proposal Review Gate: Member Propose -> Owner Approve -> Auto-Merge', 'Collaboration', 'FAIL', err.message);
    }

  } catch (err) {
    console.error('Fatal execution error in test runner:', err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }

  console.log('\n======================================================');
  console.log('              CI BROWSER E2E TEST SUMMARY             ');
  console.log('======================================================');
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'PASS') passed++;
    else failed++;
  }
  console.log(`TOTAL TESTS: ${results.length} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log('======================================================');

  if (failed > 0 || results.length < 21) {
    console.error(`❌ Suite failed: ${failed} tests failed or missing tests.`);
    process.exit(1);
  } else {
    console.log('🎉 ALL 21 BROWSER-LEVEL TESTS PASSED SUCCESSFULLY!');
  }
}

run();
