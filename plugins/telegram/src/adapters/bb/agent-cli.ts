import { cliCommand, defineCli, PluginCliError, type BbPluginApi, type PluginAgentToolContext } from "@get-bb/plugin-sdk";
import type { z } from "zod";

export type TelegramToolRegistrar = <Schema extends z.ZodObject>(tool: {
  name: string;
  description: string;
  instructions?: string;
  parameters: Schema;
  execute(args: z.output<Schema>, context: PluginAgentToolContext): string | Promise<string>;
}) => void;

export function createTelegramAgentCli(bb: Pick<BbPluginApi, "agents" | "cli" | "sdk">) {
  const commands: Record<string, ReturnType<typeof command>> = {};

  function command(summary: string, fields: string, run: (input: unknown, context: PluginAgentToolContext) => string | Promise<string>) {
    return cliCommand({
      summary,
      options: {
        input: { type: "string", description: `One JSON object. Fields: ${fields}`, required: true, stdin: true },
      },
      async run({ options }, { threadId, signal }) {
        if (!threadId || !signal || signal.aborted) {
          throw new PluginCliError("Run this command from a BB agent thread.", { code: "telegram_thread_required" });
        }
        const thread = await bb.sdk.threads.get({ threadId });
        if (!thread || signal.aborted) {
          throw new PluginCliError("The BB agent thread is unavailable.", { code: "telegram_thread_required" });
        }
        let input: unknown;
        try { input = JSON.parse(options.input); }
        catch { throw new PluginCliError("Input must be a JSON object.", { code: "telegram_invalid_input" }); }
        return { exitCode: 0, stdout: await run(input, { threadId, projectId: thread.projectId, signal }) };
      },
    });
  }

  const registerTool: TelegramToolRegistrar = (tool) => {
    bb.agents.registerTool(tool);
    const name = tool.name.replace(/^makosh_telegram_/, "").replaceAll("_", "-");
    commands[name] = command(tool.description, Object.keys(tool.parameters.shape).join(", "), (input, context) => {
      const parsed = tool.parameters.safeParse(input);
      if (!parsed.success) {
        throw new PluginCliError("Invalid Telegram tool parameters.", { code: "telegram_invalid_input" });
      }
      return tool.execute(parsed.data, context);
    });
  };

  return {
    registerTool,
    publish() {
      bb.cli.register(defineCli({
        name: "telegram",
        summary: "Use Telegram agent tools from an existing BB thread. Read only AI-enabled chats and wait for the owner to confirm any send in BB.",
        commands,
      }));
    },
  };
}
