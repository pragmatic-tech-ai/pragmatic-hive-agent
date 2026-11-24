import { AgentMain } from './agent-main.js'
import { ConsolePreflightOutput, PreflightCli } from './preflight/preflight-cli.js'

/** `pragmatic-agentd [preflight]`: no argument runs the rollout agent; `preflight` runs the engine install's checks and exits. */
export class AgentCommand
{
    private constructor()
    {
    }

    public static async Run(argv: readonly string[]): Promise<void>
    {
        if (argv[0] === PreflightCli.Command)
        {
            process.exitCode = await PreflightCli.Run(process.env, new ConsolePreflightOutput())
            return
        }
        await AgentMain.Run()
    }
}
