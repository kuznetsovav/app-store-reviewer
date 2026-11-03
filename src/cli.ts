#!/usr/bin/env node
const [, , command, ...args] = process.argv;

async function main(): Promise<void> {
  switch (command) {
    case "spike": {
      const { runSpike } = await import("./spike.js");
      await runSpike(args);
      return;
    }
    case "scan": {
      const { scanCommand } = await import("./scan/commands.js");
      await scanCommand(args);
      return;
    }
    case "status": {
      const { statusCommand } = await import("./scan/commands.js");
      statusCommand();
      return;
    }
    case "report": {
      const { reportCommand } = await import("./report/commands.js");
      reportCommand(args);
      return;
    }
    case "run": {
      const { runCommand } = await import("./report/commands.js");
      await runCommand(args);
      return;
    }
    case "prune": {
      const { pruneCommand } = await import("./report/commands.js");
      pruneCommand();
      return;
    }
    case "notify": {
      const { notifyCommand } = await import("./report/commands.js");
      await notifyCommand(args);
      return;
    }
    default:
      console.error(
        [
          "Usage: tsx src/cli.ts <command> [options]",
          "  spike [--seed ID]                                   feasibility measurements",
          "  scan [--dry-run] [--max-calls N] [--seed ID] [--new] scan for new apps (resumes today's run)",
          "  status                                              last 5 runs and the frontier",
          "  report [--date YYYY-MM-DD]                          write reports/ from the database (no API calls)",
          "  run [scan options]                                  scan, then report, then write state/state.json; exit 1 if aborted",
          "  prune                                               drop raw JSON of old apps and compact the DB",
          "  notify [--date YYYY-MM-DD]                          POST headline + watchlist to NOTIFY_WEBHOOK_URL (no-op if unset)",
        ].join("\n"),
      );
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
