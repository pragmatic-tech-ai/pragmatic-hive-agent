import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ComponentReadyFile } from '@pragmatic-tech-ai/pragmatic-configuration-runtime'
import { AgentEnrolment, type IEnrolmentWait } from '../agent-enrolment.js'

class WriteOnThirdWait implements IEnrolmentWait
{
    public Waits = 0

    public constructor(private readonly file: string)
    {
    }

    public Wait(): Promise<void>
    {
        this.Waits++
        if (this.Waits === 3)
        {
            writeFileSync(this.file, 'token\n')
        }
        return Promise.resolve()
    }
}

class EnrolmentFixture
{
    public static InTemp(body: (dir: string) => Promise<void> | void): Promise<void>
    {
        const dir = mkdtempSync(join(tmpdir(), 'agent-enrol-'))
        return Promise.resolve(body(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
    }
}

describe('AgentEnrolment', () =>
{
    it('an absent or empty token file is not enrolled; the variable or a written file is', async () =>
    {
        await EnrolmentFixture.InTemp(dir =>
        {
            const file = join(dir, 'token')
            assert.equal(AgentEnrolment.IsEnrolled({ PRAGMATIC_AGENT_TOKEN_FILE: file }), false)
            writeFileSync(file, '\n')
            assert.equal(AgentEnrolment.IsEnrolled({ PRAGMATIC_AGENT_TOKEN_FILE: file }), false)
            writeFileSync(file, 'abc')
            assert.equal(AgentEnrolment.IsEnrolled({ PRAGMATIC_AGENT_TOKEN_FILE: file }), true)
            assert.equal(AgentEnrolment.IsEnrolled({ PRAGMATIC_AGENT_TOKEN: 'abc' }), true)
            assert.equal(AgentEnrolment.IsEnrolled({}), false)
        })
    })

    it('waits ready and idle until the token file appears', async () =>
    {
        await EnrolmentFixture.InTemp(async dir =>
        {
            const file = join(dir, 'token')
            const ready = join(dir, 'ready')
            const wait = new WriteOnThirdWait(file)
            await new AgentEnrolment(wait, new ComponentReadyFile(ready)).AwaitEnrolled({ PRAGMATIC_AGENT_TOKEN_FILE: file })
            assert.equal(wait.Waits, 3)
            assert.equal(existsSync(ready), true)
        })
    })
})
