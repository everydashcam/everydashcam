/** Shared compile-time contracts for the page and worker ends of Comlink RPC.
 * The transport keeps operation ids for cancellation; these maps correlate
 * each operation with its payload/result without changing that wire protocol. */
export interface WorkerRequest<Data = unknown, Result = unknown> {
    data: Data;
    result: Result;
}

export interface WorkerContract<
    Requests extends Record<string, WorkerRequest> = Record<string, WorkerRequest>,
    Commands extends Record<string, unknown> = Record<string, unknown>,
    Events extends Record<string, unknown> = Record<string, unknown>,
    Callbacks extends Record<string, WorkerRequest> = Record<string, WorkerRequest>,
> {
    requests: Requests;
    commands: Commands;
    events: Events;
    callbacks: Callbacks;
}

export type WorkerMessage<Events extends Record<string, unknown>> = {
    [Type in keyof Events]: { type: Type; data: Events[Type] };
}[keyof Events];

export type WorkerRequestHandlers<Requests extends Record<string, WorkerRequest>, Context> = {
    [Type in keyof Requests]: (
        data: Requests[Type]["data"],
        context: Context,
    ) => Requests[Type]["result"] | Promise<Requests[Type]["result"]>;
};

export type WorkerNotificationHandlers<Commands extends Record<string, unknown>> = {
    [Type in keyof Commands]: (data: Commands[Type]) => void;
};

export type WorkerRequestArguments<
    Requests extends Record<string, WorkerRequest>,
    Options,
    Type extends keyof Requests & string = keyof Requests & string,
> = { [Key in Type]: [type: Key, data: Requests[Key]["data"], options?: Options] }[Type];

export interface WorkerRequester<Requests extends Record<string, WorkerRequest>, Options> {
    request<Args extends WorkerRequestArguments<Requests, Options>>(
        ...args: Args
    ): Promise<Requests[Args[0]]["result"]>;
}

export interface WorkerNotifier<Events extends Record<string, unknown>, Options> {
    notify<Type extends keyof Events & string>(
        ...args: {
            [Key in Type]: undefined extends Events[Key]
                ? [type: Key, data?: Events[Key], options?: Options]
                : [type: Key, data: Events[Key], options?: Options];
        }[Type]
    ): void;
}

/** The only payload assertion needed at the serialized request boundary.
 * Both ends share the same contract; this does not validate external data. */
export function dispatchWorkerRequest<Requests extends Record<string, WorkerRequest>, Context>(
    handlers: WorkerRequestHandlers<Requests, Context>,
    type: string,
    data: unknown,
    context: Context,
): unknown | Promise<unknown> {
    if (!Object.hasOwn(handlers, type)) throw new Error(`unknown request type: ${type}`);
    const handler = handlers[type] as (data: unknown, context: Context) => unknown | Promise<unknown>;
    return handler(data, context);
}

/** Unknown notifications remain ignorable, matching the transport's push policy. */
export function dispatchWorkerNotification<Commands extends Record<string, unknown>>(
    handlers: WorkerNotificationHandlers<Commands>,
    type: string,
    data: unknown,
): void {
    if (!Object.hasOwn(handlers, type)) return;
    const handler = handlers[type] as (data: unknown) => void;
    handler(data);
}
