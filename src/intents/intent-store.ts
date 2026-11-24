import { Intent, IntentFailure, IntentProgress, IntentStatus, KeptIntentView, SignedEnvelope } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { HiveIdentity } from '../identity/hive-identity.js'
import { KubeConflictError, type IHiveKube } from '../kube/hive-kube.js'

/** One intent the hive keeps: the signed envelope as pulled, its decoded body, where it stands. */
export class KeptIntent
{
    public static readonly SettledProgress: readonly IntentProgress[] = [IntentProgress.Applied, IntentProgress.Rejected, IntentProgress.Failed, IntentProgress.Expired]

    public constructor(
        public readonly Envelope: SignedEnvelope,
        public readonly Intent: Intent,
        public readonly Status: IntentStatus,
        /** The image a component-at-version replaced (so a restarted agent can still put it back). */
        public readonly PreviousImage: string | null = null,
        /** The hive's signed approval (an IntentDecision under the hive key): what lets an Enrolled intent apply. */
        public readonly Decision: SignedEnvelope | null = null,
        /** The pull cursor of the batch it came in (the agent's own upgrade waits for the rest of its batch). */
        public readonly Batch: number = 0,
        /** Its settled status has been in a report the platform took (only then may it be pruned). */
        public readonly Reported: boolean = false,
        /** Sent back to waiting because it was applying without Delegated mode or a valid approval. */
        public readonly Demoted: boolean = false)
    {
    }

    public get IntentId(): string
    {
        return this.Intent.IntentId
    }

    public get Digest(): string
    {
        return this.Envelope.Digest
    }

    public get Progress(): IntentProgress
    {
        return this.Status.Progress
    }

    /** Applied, rejected, failed or expired: nothing more happens to it. */
    public get Settled(): boolean
    {
        return KeptIntent.SettledProgress.includes(this.Status.Progress)
    }

    /**
     * How far it got, for a merge (the higher wins): settled; applying with an approval; demoted (applying without one was
     * sent back to waiting, so a stale applying copy never undoes that); applying; waiting.
     */
    public get Rank(): number
    {
        if (this.Settled)
        {
            return 4
        }
        if (this.Progress === IntentProgress.Applying)
        {
            return this.Decision !== null ? 3 : 1
        }
        return this.Demoted ? 2 : 0
    }

    /** Back to waiting for an approval (applying without Delegated mode or a valid approval). */
    public Demote(): KeptIntent
    {
        return new KeptIntent(this.Envelope, this.Intent, IntentStatus.Of(this.IntentId, IntentProgress.AwaitingApproval), this.PreviousImage, this.Decision, this.Batch, false, true)
    }

    public With(progress: IntentProgress): KeptIntent
    {
        return this.WithStatus(IntentStatus.Of(this.IntentId, progress))
    }

    public Failed(failure: IntentFailure): KeptIntent
    {
        return this.WithStatus(IntentStatus.FailedWith(this.IntentId, failure))
    }

    public WithStatus(status: IntentStatus): KeptIntent
    {
        return new KeptIntent(this.Envelope, this.Intent, status, this.PreviousImage, this.Decision, this.Batch, false)
    }

    public WithPrevious(image: string): KeptIntent
    {
        return new KeptIntent(this.Envelope, this.Intent, this.Status, image, this.Decision, this.Batch, this.Reported, this.Demoted)
    }

    public WithDecision(decision: SignedEnvelope): KeptIntent
    {
        return new KeptIntent(this.Envelope, this.Intent, this.Status, this.PreviousImage, decision, this.Batch, this.Reported, false)
    }

    public AsReported(): KeptIntent
    {
        return new KeptIntent(this.Envelope, this.Intent, this.Status, this.PreviousImage, this.Decision, this.Batch, true, this.Demoted)
    }

    public View(): KeptIntentView
    {
        return KeptIntentView.Create({
            IntentId: this.IntentId, IntentDigest: this.Digest, Level: this.Intent.Level, Action: this.Intent.Action,
            IssuedAt: this.Envelope.IssuedAt, ExpiresAt: this.Envelope.ExpiresAt, Status: this.Status,
        })
    }

    /** Of two kept copies of an id (this agent's and another pod's): the newer intent, then the one that got further. */
    public static Merged(mine: KeptIntent, theirs: KeptIntent): KeptIntent
    {
        if (mine.Digest !== theirs.Digest)
        {
            return theirs.Envelope.IssuedAt.getTime() > mine.Envelope.IssuedAt.getTime() ? theirs : mine
        }
        const further = theirs.Rank > mine.Rank ? theirs : mine
        const other = further === mine ? theirs : mine
        let merged = further
        if (merged.Decision === null && other.Decision !== null)
        {
            merged = merged.WithDecision(other.Decision)
        }
        if (merged.PreviousImage === null && other.PreviousImage !== null)
        {
            merged = merged.WithPrevious(other.PreviousImage)
        }
        return merged
    }
}

/** The kept intents no longer fit the ConfigMap even after the reported settled ones were pruned. */
export class IntentStoreFullError extends Error
{
    private static readonly ErrorName = 'IntentStoreFullError'
    private static readonly Text = 'the ConfigMap pragmatic-hive-intents is full of unsettled or unreported intents'

    public constructor()
    {
        super(IntentStoreFullError.Text)
        this.name = IntentStoreFullError.ErrorName
    }
}

interface IKeptIntentJson
{
    Envelope: string
    Status: ReturnType<IntentStatus['ToJson']>
    PreviousImage: string | null
    Decision: string | null
    Batch: number
    Reported: boolean
    Demoted: boolean
}

/**
 * The intents the hive keeps (C3.4), in the ConfigMap `pragmatic-hive-intents` of the agent's namespace (not a CRD:
 * nothing to install in a customer's cluster): the pull cursor, every kept intent oldest first (its signed envelope's
 * wire text, its status, the hive's signed approval) and the ids it had to refuse because it was full. Kept across
 * restarts; at most about 1 MiB: only settled intents a report already carried are pruned (oldest first). Two agent
 * pods (a self-upgrade's overlap) may both write: every write names the version it read, and a conflict reloads, merges
 * (the newer intent per id, then the furthest progress) and writes again. What is read back is trusted for nothing:
 * every kept intent is rechecked, and an approval verified, before it is decided on or applied.
 */
export class IntentStore
{
    public static readonly ConfigMapName = 'pragmatic-hive-intents'
    /** Below the ConfigMap's 1 MiB, leaving room for the object's own metadata. */
    public static readonly MaxBytes = 900_000
    public static readonly MaxRefused = 200
    private static readonly CursorKey = 'cursor'
    private static readonly IntentsKey = 'intents.json'
    private static readonly RefusedKey = 'refused.json'
    private static readonly StatusPath = 'status'
    private static readonly MaxWriteAttempts = 4
    private intents: KeptIntent[] = []
    private refused: string[] = []
    private cursor = 0
    private resourceVersion: string | undefined

    public constructor(private readonly kube: IHiveKube, private readonly namespace: string, private readonly maxBytes: number = IntentStore.MaxBytes)
    {
    }

    public get Cursor(): number
    {
        return this.cursor
    }

    /** Reads the ConfigMap, replacing what is in memory (the agent's start). */
    public async Load(): Promise<void>
    {
        const remote = await this.Read()
        this.resourceVersion = remote.Version
        this.cursor = remote.Cursor
        this.intents = remote.Intents
        this.refused = remote.Refused
    }

    /** Reads the ConfigMap and merges it into what is in memory (another pod's or a decision's writes). */
    public async Refresh(): Promise<void>
    {
        const remote = await this.Read()
        this.resourceVersion = remote.Version
        this.cursor = Math.max(this.cursor, remote.Cursor)
        for (const theirs of remote.Intents)
        {
            const mine = this.Get(theirs.IntentId)
            this.Put(mine === undefined ? theirs : KeptIntent.Merged(mine, theirs))
        }
        this.refused = [...new Set([...this.refused, ...remote.Refused])].slice(-IntentStore.MaxRefused)
    }

    public All(): readonly KeptIntent[]
    {
        return this.intents
    }

    public Get(intentId: string): KeptIntent | undefined
    {
        return this.intents.find(intent => intent.IntentId === intentId)
    }

    /** Keeps `intent`, replacing one of the same id (a reissue under the same id is a new intent: its own status). */
    public Put(intent: KeptIntent): void
    {
        const index = this.intents.findIndex(kept => kept.IntentId === intent.IntentId)
        if (index >= 0)
        {
            this.intents[index] = intent
        }
        else
        {
            this.intents.push(intent)
        }
    }

    /** Forgets `intentIds` (just admitted, but there is no room) and remembers them as refused, to report them failed. */
    public Refuse(intentIds: readonly string[]): void
    {
        this.intents = this.intents.filter(intent => !intentIds.includes(intent.IntentId))
        this.refused = [...new Set([...this.refused, ...intentIds])].slice(-IntentStore.MaxRefused)
    }

    public SetCursor(cursor: number): void
    {
        this.cursor = cursor
    }

    /** The statuses a report carries, at most `max`: unsettled first, then the refused, then the settled not yet reported, then the rest (newest first). */
    public Statuses(max: number): IntentStatus[]
    {
        const newest = [...this.intents].reverse()
        const refused = this.refused.map(id => IntentStatus.FailedWith(id, IntentFailure.PrecheckRefused))
        return [
            ...newest.filter(intent => !intent.Settled).map(intent => intent.Status),
            ...refused,
            ...newest.filter(intent => intent.Settled && !intent.Reported).map(intent => intent.Status),
            ...newest.filter(intent => intent.Settled && intent.Reported).map(intent => intent.Status),
        ].slice(0, max)
    }

    /** The platform took a report carrying `statuses`: settled ones may be pruned from now on, refused ones forgotten. */
    public async MarkReported(statuses: readonly IntentStatus[]): Promise<void>
    {
        let changed = false
        for (const status of statuses)
        {
            const kept = this.Get(status.IntentId)
            if (kept !== undefined && kept.Settled && !kept.Reported && kept.Status.Progress === status.Progress)
            {
                this.Put(kept.AsReported())
                changed = true
            }
        }
        const before = this.refused.length
        this.refused = this.refused.filter(id => !statuses.some(status => status.IntentId === id))
        if (changed || this.refused.length !== before)
        {
            await this.Save()
        }
    }

    /** Writes the store, pruning reported settled intents to fit; a conflict reloads, merges and writes again. */
    public async Save(): Promise<void>
    {
        const S = IntentStore
        for (let attempt = 1; ; attempt++)
        {
            const data = this.Fit()
            try
            {
                this.resourceVersion = await this.kube.PutConfigMap(this.namespace, S.ConfigMapName, data, HiveIdentity.Labels, this.resourceVersion)
                return
            }
            catch (error)
            {
                if (!(error instanceof KubeConflictError) || attempt >= S.MaxWriteAttempts)
                {
                    throw error
                }
                await this.Refresh()
            }
        }
    }

    private Fit(): Record<string, string>
    {
        const S = IntentStore
        let text = S.Encode(this.intents)
        while (Buffer.byteLength(text) > this.maxBytes)
        {
            const oldest = this.intents.findIndex(intent => intent.Settled && intent.Reported)
            if (oldest < 0)
            {
                throw new IntentStoreFullError()
            }
            this.intents.splice(oldest, 1)
            text = S.Encode(this.intents)
        }
        return { [S.CursorKey]: String(this.cursor), [S.IntentsKey]: text, [S.RefusedKey]: JSON.stringify(this.refused) }
    }

    private async Read(): Promise<{ Version: string | undefined, Cursor: number, Intents: KeptIntent[], Refused: string[] }>
    {
        const S = IntentStore
        const map = await this.kube.GetConfigMap(this.namespace, S.ConfigMapName)
        const cursor = Number(map?.Data[S.CursorKey] ?? 0)
        return {
            Version: map?.ResourceVersion,
            Cursor: Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0,
            Intents: S.Decode(map?.Data[S.IntentsKey]),
            Refused: S.DecodeRefused(map?.Data[S.RefusedKey]),
        }
    }

    private static Encode(intents: readonly KeptIntent[]): string
    {
        const entries: IKeptIntentJson[] = intents.map(intent => ({
            Envelope: intent.Envelope.Encode(), Status: intent.Status.ToJson(), PreviousImage: intent.PreviousImage,
            Decision: intent.Decision?.Encode() ?? null, Batch: intent.Batch, Reported: intent.Reported, Demoted: intent.Demoted,
        }))
        return JSON.stringify(entries)
    }

    private static DecodeRefused(text: string | undefined): string[]
    {
        try
        {
            const raw = JSON.parse(text ?? '[]') as unknown
            return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string').slice(-IntentStore.MaxRefused) : []
        }
        catch
        {
            return []
        }
    }

    /** The kept entries that still decode; anything else (an edited ConfigMap) is dropped, never trusted. */
    private static Decode(text: string | undefined): KeptIntent[]
    {
        if (text === undefined || text === '')
        {
            return []
        }
        let raw: unknown
        try
        {
            raw = JSON.parse(text)
        }
        catch
        {
            return []
        }
        const kept: KeptIntent[] = []
        for (const entry of Array.isArray(raw) ? raw as IKeptIntentJson[] : [])
        {
            try
            {
                const envelope = SignedEnvelope.Decode(entry.Envelope)
                const intent = Intent.Parse(envelope.Body)
                const status = IntentStatus.Parse(entry.Status, IntentStore.StatusPath)
                if (status.IntentId !== intent.IntentId || kept.some(other => other.IntentId === intent.IntentId))
                {
                    continue
                }
                const decision = typeof entry.Decision === 'string' ? SignedEnvelope.Decode(entry.Decision) : null
                const batch = Number.isSafeInteger(entry.Batch) ? entry.Batch : 0
                kept.push(new KeptIntent(envelope, intent, status, typeof entry.PreviousImage === 'string' ? entry.PreviousImage : null, decision, batch, entry.Reported === true, entry.Demoted === true))
            }
            catch
            {
                continue
            }
        }
        return kept
    }
}
