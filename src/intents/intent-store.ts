import { Intent, IntentProgress, IntentStatus, KeptIntentView, SignedEnvelope, type IntentFailure } from '@pragmatic-tech-ai/pragmatic-hive-protocol'
import { HiveIdentity } from '../identity/hive-identity.js'
import type { IHiveKube } from '../kube/hive-kube.js'

/** One intent the hive keeps: the signed envelope as pulled, its decoded body, where it stands. */
export class KeptIntent
{
    public constructor(
        public readonly Envelope: SignedEnvelope,
        public readonly Intent: Intent,
        public readonly Status: IntentStatus,
        /** The image a component-at-version replaced (so a restarted agent can still put it back). */
        public readonly PreviousImage: string | null = null)
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

    public With(progress: IntentProgress): KeptIntent
    {
        return new KeptIntent(this.Envelope, this.Intent, IntentStatus.Of(this.IntentId, progress), this.PreviousImage)
    }

    public Failed(failure: IntentFailure): KeptIntent
    {
        return new KeptIntent(this.Envelope, this.Intent, IntentStatus.FailedWith(this.IntentId, failure), this.PreviousImage)
    }

    public WithStatus(status: IntentStatus): KeptIntent
    {
        return new KeptIntent(this.Envelope, this.Intent, status, this.PreviousImage)
    }

    public WithPrevious(image: string): KeptIntent
    {
        return new KeptIntent(this.Envelope, this.Intent, this.Status, image)
    }

    public View(): KeptIntentView
    {
        return KeptIntentView.Create({
            IntentId: this.IntentId, IntentDigest: this.Digest, Level: this.Intent.Level, Action: this.Intent.Action,
            IssuedAt: this.Envelope.IssuedAt, ExpiresAt: this.Envelope.ExpiresAt, Status: this.Status,
        })
    }

    public static readonly SettledProgress: readonly IntentProgress[] = [IntentProgress.Applied, IntentProgress.Rejected, IntentProgress.Failed, IntentProgress.Expired]
}

/** The kept intents no longer fit the ConfigMap even after the settled ones were pruned. */
export class IntentStoreFullError extends Error
{
    private static readonly ErrorName = 'IntentStoreFullError'
    private static readonly Text = 'the ConfigMap pragmatic-hive-intents is full of unsettled intents'

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
}

/**
 * The intents the hive keeps (C3.4), in the ConfigMap `pragmatic-hive-intents` of the agent's namespace (not a CRD:
 * nothing to install in a customer's cluster): the pull cursor and every kept intent, oldest first, each as its signed
 * envelope's wire text and its status. Kept across restarts; at most about 1 MiB, the oldest settled intents pruned
 * first. What is read back is trusted for nothing: every kept intent is rechecked before it is decided on or applied.
 */
export class IntentStore
{
    public static readonly ConfigMapName = 'pragmatic-hive-intents'
    /** Below the ConfigMap's 1 MiB, leaving room for the object's own metadata. */
    public static readonly MaxBytes = 900_000
    private static readonly CursorKey = 'cursor'
    private static readonly IntentsKey = 'intents.json'
    private static readonly StatusPath = 'status'
    private intents: KeptIntent[] = []
    private cursor = 0
    private resourceVersion: string | undefined

    public constructor(private readonly kube: IHiveKube, private readonly namespace: string, private readonly maxBytes: number = IntentStore.MaxBytes)
    {
    }

    public get Cursor(): number
    {
        return this.cursor
    }

    public async Load(): Promise<void>
    {
        const S = IntentStore
        const map = await this.kube.GetConfigMap(this.namespace, S.ConfigMapName)
        this.resourceVersion = map?.ResourceVersion
        const cursor = Number(map?.Data[S.CursorKey] ?? 0)
        this.cursor = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0
        this.intents = S.Decode(map?.Data[S.IntentsKey])
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

    public SetCursor(cursor: number): void
    {
        this.cursor = cursor
    }

    /** The statuses a report carries: the most recent, at most `max`. */
    public Statuses(max: number): IntentStatus[]
    {
        return this.intents.slice(-max).map(intent => intent.Status)
    }

    public async Save(): Promise<void>
    {
        const S = IntentStore
        let text = S.Encode(this.intents)
        while (Buffer.byteLength(text) > this.maxBytes)
        {
            const oldest = this.intents.findIndex(intent => intent.Settled)
            if (oldest < 0)
            {
                throw new IntentStoreFullError()
            }
            this.intents.splice(oldest, 1)
            text = S.Encode(this.intents)
        }
        await this.kube.PutConfigMap(this.namespace, S.ConfigMapName, { [S.CursorKey]: String(this.cursor), [S.IntentsKey]: text }, HiveIdentity.Labels, this.resourceVersion)
        this.resourceVersion = (await this.kube.GetConfigMap(this.namespace, S.ConfigMapName))?.ResourceVersion
    }

    private static Encode(intents: readonly KeptIntent[]): string
    {
        const entries: IKeptIntentJson[] = intents.map(intent => ({ Envelope: intent.Envelope.Encode(), Status: intent.Status.ToJson(), PreviousImage: intent.PreviousImage }))
        return JSON.stringify(entries)
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
                kept.push(new KeptIntent(envelope, intent, status, typeof entry.PreviousImage === 'string' ? entry.PreviousImage : null))
            }
            catch
            {
                continue
            }
        }
        return kept
    }
}
