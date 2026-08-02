import { VirtualClock } from '../domain/clock.js';

export type Fault =
  | { kind: 'dropResponse' }
  | { kind: 'duplicate' };

export interface HttpResponse {
  status: number;
  body: unknown;
}

export interface HttpClient {
  post(path: string, body: unknown, faults?: Fault[]): Promise<HttpResponse>;
  get(path: string): Promise<HttpResponse>;
}

export class FetchClient implements HttpClient {
  constructor(private baseUrl: string) {}

  async get(path: string): Promise<HttpResponse> {
    const res = await fetch(`${this.baseUrl}${path}`);
    return { status: res.status, body: await safeJson(res) };
  }

  async post(path: string, body: unknown, faults: Fault[] = []): Promise<HttpResponse> {
    const drop = faults.some((f) => f.kind === 'dropResponse');
    const duplicate = faults.some((f) => f.kind === 'duplicate');

    const sendOnce = async (abort: boolean): Promise<HttpResponse | null> => {
      const controller = new AbortController();
      const promise = fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (abort) {
        controller.abort();
        try {
          await promise;
        } catch {
          return null;
        }
        return null;
      }
      try {
        const res = await promise;
        return { status: res.status, body: await safeJson(res) };
      } catch (err) {
        return { status: 0, body: { error: (err as Error).message } };
      }
    };

    if (drop) {
      await sendOnce(true);
      return { status: 0, body: { error: 'simulated response loss (crash after write)' } };
    }

    const first = await sendOnce(false);
    if (duplicate) {
      const second = await sendOnce(false);
      return {
        status: 200,
        body: { duplicated: true, first, second },
      };
    }
    return first!;
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

export type StepResult =
  | { step: string; ok: true; data: unknown }
  | { step: string; ok: false; error: string; data?: unknown };

export interface SimStep {
  name: string;
  run: (ctx: SimContext) => Promise<StepResult>;
}

export interface SimContext {
  client: HttpClient;
  clock: VirtualClock;
  state: Record<string, unknown>;
  log: (line: string) => void;
}

export class ScenarioRunner {
  readonly clock: VirtualClock;
  readonly results: StepResult[] = [];

  constructor(private client: HttpClient, private logger: (line: string) => void = () => {}) {
    this.clock = new VirtualClock(0);
  }

  async run(steps: SimStep[]): Promise<StepResult[]> {
    const state: Record<string, unknown> = {};
    const ctx: SimContext = {
      client: this.client,
      clock: this.clock,
      state,
      log: this.logger,
    };
    for (const step of steps) {
      this.clock.advance(1);
      try {
        const result = await step.run(ctx);
        this.results.push(result);
        this.logger(`${result.ok ? 'PASS' : 'FAIL'} [${step.name}]`);
      } catch (err) {
        const result: StepResult = {
          step: step.name,
          ok: false,
          error: (err as Error).message,
        };
        this.results.push(result);
        this.logger(`FAIL [${step.name}]: ${(err as Error).message}`);
      }
    }
    return this.results;
  }
}
