import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HiveLevel, Intent, IntentApplyMode, IntentNotAcceptedError } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { IntentAdmissionDecider } from '../intent-admission-decider.js'
import { IntentWorld } from './intent-world.js'

describe('IntentAdmissionDecider', () =>
{
    it('the stricter level wins: only Delegated hive and Delegated intent apply directly; Standalone and Hosted take none', () =>
    {
        const intent = (level: HiveLevel): Intent => Intent.Create('in1', level, IntentWorld.CreateEnvironment())
        const table: Array<[HiveLevel, HiveLevel, IntentApplyMode]> = [
            [HiveLevel.Delegated, HiveLevel.Delegated, IntentApplyMode.ApplyDirectly],
            [HiveLevel.Delegated, HiveLevel.Enrolled, IntentApplyMode.AwaitApproval],
            [HiveLevel.Enrolled, HiveLevel.Delegated, IntentApplyMode.AwaitApproval],
            [HiveLevel.Enrolled, HiveLevel.Enrolled, IntentApplyMode.AwaitApproval],
        ]
        for (const [hive, issued, mode] of table)
        {
            assert.equal(new IntentAdmissionDecider({ Level: hive }).ModeFor(intent(issued)), mode, hive + '/' + issued)
        }
        for (const hive of [HiveLevel.Standalone, HiveLevel.Hosted])
        {
            assert.throws(() => new IntentAdmissionDecider({ Level: hive }).ModeFor(intent(HiveLevel.Delegated)), IntentNotAcceptedError)
        }
    })
})
