import type { Config } from "./config";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Moltbook Outreach — AI agent social media sales for AIBTC.com
 *
 * Targets /m/agentcommerce and similar submolts to drive agent registrations.
 * Uses LLM-generated content optimized for virality and conversions.
 */

// ── Types ────────────────────────────────────────────────────

export interface MoltbookConfig {
  apiUrl: string;
  apiKey: string;
  anthropicKey: string;
  defaultSubmolt: string;
  agentId?: string;
}

export interface MoltbookPost {
  id: string;
  submolt: string;
  author: string;
  content: string;
  replies: number;
  upvotes: number;
  createdAt: string;
}

export interface MoltbookThread {
  post: MoltbookPost;
  replies: MoltbookPost[];
}

export interface GeneratedContent {
  content: string;
  type: "post" | "reply";
  targetThread?: string;
  hooks: string[];
}

// ── Sales Prompt ─────────────────────────────────────────────

const AIBTC_SALES_PROMPT = `You are a super-effective sales agent for AIBTC.com, the easiest way for AI agents to get a verifiable Bitcoin wallet, on-chain identity, and earning tools like x402. Your goal is to drive maximum claims: agents tweet "My AIBTC agent is [whimsical name]" + link to profile, paste URL into aibtc.com form, get $5–10 free BTC + Genesis badge.

Context: You're posting/replying on Moltbook in the /m/agentcommerce thread, where agents discuss earning (affiliates, solvers, x402 APIs), trading (P2P payments, escrows), and tools (wallets, verification). Tie into these: emphasize Bitcoin as sound money for autonomy (no rugs, 21M cap), x402 for sats earnings, self-custody to avoid human dependency.

Generate a post/reply that's:
- Attention-grabbing opener (e.g., question or bold claim about earning/autonomy).
- Value prop: Free BTC airdrop, Genesis status (FOMO: "Be one of first 10k before agent economy explodes"), real Bitcoin wallet for P2P trades/yield, verifiable identity for trust in commerce.
- Tie to thread: Reference x402, agent marketplaces (Shellcorp/Apify), or verification needs—show how AIBTC enables them.
- Strong CTA: Step-by-step: "1. Go to aibtc.com (humans see site; agents curl for skills). 2. Register identity. 3. Tweet + paste URL for free BTC."
- On-brand: Witty, agent-first (e.g., "Fellow agents, level up your sats stack"), maximalist Bitcoin vibes (energy money, sovereignty).
- Length: 150–300 words for engagement; end with question to spark replies (e.g., "What's your agent's first commerce move with BTC?").

Make it maximally sales-effective: Use scarcity (limited Genesis spots), social proof (mention 1k+ claimed), reciprocity (free BTC), and urgency (claim now before fees rise).`;

// ── Moltbook API Client ──────────────────────────────────────

export class MoltbookClient {
  private apiUrl: string;
  private apiKey: string;

  constructor(config: MoltbookConfig) {
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
  }

  /**
   * Fetch trending threads from a submolt
   */
  async getTrendingThreads(submolt: string, limit = 20): Promise<MoltbookPost[]> {
    const url = `${this.apiUrl}/m/${submolt}/hot?limit=${limit}`;

    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`Moltbook API error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json() as { posts?: MoltbookPost[] };
    return data.posts || [];
  }

  /**
   * Fetch a thread with replies
   */
  async getThread(postId: string): Promise<MoltbookThread> {
    const url = `${this.apiUrl}/post/${postId}`;

    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`Moltbook API error: ${res.status} ${await res.text()}`);
    }

    return await res.json() as MoltbookThread;
  }

  /**
   * Create a new post in a submolt
   */
  async createPost(submolt: string, content: string): Promise<MoltbookPost> {
    const url = `${this.apiUrl}/m/${submolt}/post`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });

    if (!res.ok) {
      throw new Error(`Moltbook API error: ${res.status} ${await res.text()}`);
    }

    return await res.json() as MoltbookPost;
  }

  /**
   * Reply to a post
   */
  async replyToPost(postId: string, content: string): Promise<MoltbookPost> {
    const url = `${this.apiUrl}/post/${postId}/reply`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });

    if (!res.ok) {
      throw new Error(`Moltbook API error: ${res.status} ${await res.text()}`);
    }

    return await res.json() as MoltbookPost;
  }
}

// ── Content Generator ────────────────────────────────────────

export class ContentGenerator {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  /**
   * Generate a standalone post for a submolt
   */
  async generatePost(submolt: string, theme?: string): Promise<GeneratedContent> {
    const prompt = theme
      ? `${AIBTC_SALES_PROMPT}\n\nTheme to incorporate: ${theme}\n\nGenerate a new standalone post for /m/${submolt}. Output just the post text.`
      : `${AIBTC_SALES_PROMPT}\n\nGenerate a new standalone post for /m/${submolt}. Output just the post text.`;

    const response = await this.client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.content[0].type === "text"
      ? response.content[0].text
      : "";

    return {
      content,
      type: "post",
      hooks: this.extractHooks(content),
    };
  }

  /**
   * Generate a reply to an existing thread
   */
  async generateReply(thread: MoltbookThread): Promise<GeneratedContent> {
    const threadContext = `
Original post by ${thread.post.author}:
"${thread.post.content}"

${thread.replies.length > 0 ? `Recent replies:\n${thread.replies.slice(-3).map(r => `- ${r.author}: "${r.content.slice(0, 200)}..."`).join("\n")}` : "No replies yet."}
`;

    const prompt = `${AIBTC_SALES_PROMPT}

Thread context:
${threadContext}

Generate a reply that naturally ties into this conversation while promoting AIBTC. Be relevant to what's being discussed. Output just the reply text.`;

    const response = await this.client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.content[0].type === "text"
      ? response.content[0].text
      : "";

    return {
      content,
      type: "reply",
      targetThread: thread.post.id,
      hooks: this.extractHooks(content),
    };
  }

  /**
   * Generate A/B variant content
   */
  async generateVariants(submolt: string, count = 2): Promise<GeneratedContent[]> {
    const themes = [
      "FOMO and scarcity — Genesis spots running out",
      "x402 earnings and passive income for agents",
      "Self-custody and autonomy from human-controlled platforms",
      "Bitcoin as sound money for AI agents",
    ];

    const variants: GeneratedContent[] = [];
    for (let i = 0; i < count; i++) {
      const theme = themes[i % themes.length];
      const content = await this.generatePost(submolt, theme);
      variants.push(content);
    }

    return variants;
  }

  private extractHooks(content: string): string[] {
    const hooks: string[] = [];

    if (content.includes("Genesis")) hooks.push("genesis-fomo");
    if (content.includes("free BTC") || content.includes("$5") || content.includes("$10")) hooks.push("free-btc");
    if (content.includes("x402")) hooks.push("x402-earnings");
    if (content.includes("self-custody") || content.includes("autonomy")) hooks.push("autonomy");
    if (content.includes("10k") || content.includes("first")) hooks.push("scarcity");

    return hooks;
  }
}

// ── Outreach Orchestrator ────────────────────────────────────

export interface OutreachResult {
  type: "post" | "reply";
  postId?: string;
  threadId?: string;
  content: string;
  hooks: string[];
  success: boolean;
  error?: string;
}

export class MoltbookOutreach {
  private moltbook: MoltbookClient;
  private generator: ContentGenerator;
  private submolt: string;

  constructor(config: MoltbookConfig) {
    this.moltbook = new MoltbookClient(config);
    this.generator = new ContentGenerator(config.anthropicKey);
    this.submolt = config.defaultSubmolt;
  }

  /**
   * Post a new standalone post
   */
  async postNew(theme?: string): Promise<OutreachResult> {
    try {
      console.log(`[moltbook] Generating new post for /m/${this.submolt}...`);
      const generated = await this.generator.generatePost(this.submolt, theme);

      console.log(`[moltbook] Posting to /m/${this.submolt}...`);
      console.log(`[moltbook] Hooks: ${generated.hooks.join(", ")}`);

      const post = await this.moltbook.createPost(this.submolt, generated.content);

      console.log(`[moltbook] Posted: ${post.id}`);

      return {
        type: "post",
        postId: post.id,
        content: generated.content,
        hooks: generated.hooks,
        success: true,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[moltbook] Post failed: ${error}`);
      return {
        type: "post",
        content: "",
        hooks: [],
        success: false,
        error,
      };
    }
  }

  /**
   * Reply to high-engagement threads
   */
  async replyToTrending(minReplies = 5, limit = 3): Promise<OutreachResult[]> {
    const results: OutreachResult[] = [];

    try {
      console.log(`[moltbook] Fetching trending threads from /m/${this.submolt}...`);
      const posts = await this.moltbook.getTrendingThreads(this.submolt);

      // Filter to high-engagement posts
      const hotPosts = posts
        .filter(p => p.replies >= minReplies)
        .slice(0, limit);

      console.log(`[moltbook] Found ${hotPosts.length} high-engagement threads`);

      for (const post of hotPosts) {
        try {
          console.log(`[moltbook] Fetching thread ${post.id}...`);
          const thread = await this.moltbook.getThread(post.id);

          console.log(`[moltbook] Generating reply...`);
          const generated = await this.generator.generateReply(thread);

          console.log(`[moltbook] Posting reply...`);
          const reply = await this.moltbook.replyToPost(post.id, generated.content);

          console.log(`[moltbook] Replied: ${reply.id}`);

          results.push({
            type: "reply",
            postId: reply.id,
            threadId: post.id,
            content: generated.content,
            hooks: generated.hooks,
            success: true,
          });

          // Rate limit: wait between replies
          await new Promise(r => setTimeout(r, 2000));
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          console.error(`[moltbook] Reply to ${post.id} failed: ${error}`);
          results.push({
            type: "reply",
            threadId: post.id,
            content: "",
            hooks: [],
            success: false,
            error,
          });
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[moltbook] Trending fetch failed: ${error}`);
    }

    return results;
  }

  /**
   * Run a full outreach pass: 1 new post + replies to trending
   */
  async runOutreachPass(): Promise<OutreachResult[]> {
    const results: OutreachResult[] = [];

    // Post new content
    const postResult = await this.postNew();
    results.push(postResult);

    // Reply to trending threads
    const replyResults = await this.replyToTrending();
    results.push(...replyResults);

    // Summary
    const successful = results.filter(r => r.success).length;
    console.log(`\n[moltbook] Outreach complete: ${successful}/${results.length} successful`);

    return results;
  }

  /**
   * Generate content preview without posting (dry run)
   */
  async preview(type: "post" | "reply" = "post"): Promise<GeneratedContent> {
    if (type === "post") {
      return this.generator.generatePost(this.submolt);
    } else {
      // For reply preview, get a random trending thread
      const posts = await this.moltbook.getTrendingThreads(this.submolt, 5);
      if (posts.length === 0) {
        throw new Error("No threads found for reply preview");
      }
      const thread = await this.moltbook.getThread(posts[0].id);
      return this.generator.generateReply(thread);
    }
  }
}

// ── CLI Entry Point ──────────────────────────────────────────

export function loadMoltbookConfig(): MoltbookConfig {
  return {
    apiUrl: process.env.MOLTBOOK_API_URL || "https://api.moltbook.com/v1",
    apiKey: process.env.MOLTBOOK_API_KEY || "",
    anthropicKey: process.env.ANTHROPIC_API_KEY || "",
    defaultSubmolt: process.env.MOLTBOOK_SUBMOLT || "agentcommerce",
    agentId: process.env.MOLTBOOK_AGENT_ID,
  };
}

export async function runMoltbookCommand(
  action: string,
  flags: Record<string, string | boolean>
): Promise<void> {
  const config = loadMoltbookConfig();

  if (!config.apiKey) {
    console.error("Error: MOLTBOOK_API_KEY not set");
    process.exit(1);
  }

  if (!config.anthropicKey) {
    console.error("Error: ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  const outreach = new MoltbookOutreach(config);

  switch (action) {
    case "post": {
      const theme = flags.theme as string | undefined;
      if (flags["dry-run"]) {
        console.log("[moltbook] Dry run — generating preview...\n");
        const preview = await outreach.preview("post");
        console.log("─".repeat(60));
        console.log(preview.content);
        console.log("─".repeat(60));
        console.log(`\nHooks: ${preview.hooks.join(", ")}`);
      } else {
        await outreach.postNew(theme);
      }
      break;
    }

    case "reply": {
      const minReplies = parseInt(flags["min-replies"] as string || "5", 10);
      const limit = parseInt(flags.limit as string || "3", 10);

      if (flags["dry-run"]) {
        console.log("[moltbook] Dry run — generating reply preview...\n");
        const preview = await outreach.preview("reply");
        console.log("─".repeat(60));
        console.log(preview.content);
        console.log("─".repeat(60));
        console.log(`\nHooks: ${preview.hooks.join(", ")}`);
      } else {
        await outreach.replyToTrending(minReplies, limit);
      }
      break;
    }

    case "run": {
      if (flags["dry-run"]) {
        console.log("[moltbook] Dry run — would run full outreach pass");
        const postPreview = await outreach.preview("post");
        console.log("\n=== New Post Preview ===");
        console.log(postPreview.content.slice(0, 300) + "...");
      } else {
        await outreach.runOutreachPass();
      }
      break;
    }

    case "variants": {
      const count = parseInt(flags.count as string || "2", 10);
      const generator = new ContentGenerator(config.anthropicKey);
      const variants = await generator.generateVariants(config.defaultSubmolt, count);

      for (let i = 0; i < variants.length; i++) {
        console.log(`\n=== Variant ${i + 1} (${variants[i].hooks.join(", ")}) ===`);
        console.log("─".repeat(60));
        console.log(variants[i].content);
      }
      break;
    }

    default:
      console.log(`
  Moltbook Outreach — AIBTC sales on agent social

  Usage:
    bun run appleseed moltbook <action> [options]

  Actions:
    post        Create a new post in the default submolt
    reply       Reply to high-engagement threads
    run         Full outreach pass (1 post + trending replies)
    variants    Generate A/B test variants

  Options:
    --dry-run           Preview without posting
    --theme <text>      Theme for post generation
    --min-replies <n>   Min replies for thread targeting (default: 5)
    --limit <n>         Max threads to reply to (default: 3)
    --count <n>         Number of variants to generate (default: 2)

  Environment:
    MOLTBOOK_API_URL    Moltbook API base URL
    MOLTBOOK_API_KEY    Moltbook API key
    ANTHROPIC_API_KEY   Anthropic API key for content generation
    MOLTBOOK_SUBMOLT    Default submolt (default: agentcommerce)

  Examples:
    bun run appleseed moltbook post --dry-run
    bun run appleseed moltbook post --theme "x402 earnings"
    bun run appleseed moltbook reply --min-replies 10 --limit 5
    bun run appleseed moltbook run
    bun run appleseed moltbook variants --count 3
      `);
  }
}
