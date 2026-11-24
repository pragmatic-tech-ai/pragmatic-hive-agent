import { AgentCommand } from '../agent-command.js'
import { AgentMain } from '../agent-main.js'

await AgentCommand.Run(process.argv.slice(2)).catch(AgentMain.Fail)
