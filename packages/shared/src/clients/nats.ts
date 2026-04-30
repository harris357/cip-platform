// Central NATS wrapper — the only file that imports @nats-io/* directly.
// Everything else in the monorepo imports from this module.
//
// Migrated from the legacy `nats@2.x` package (frozen, incompatible with
// NATS server 2.11+) to the modular `@nats-io/*` v3 packages.

import { connect } from '@nats-io/transport-node';
import {
  jetstream,
  jetstreamManager,
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StorageType,
  type JetStreamClient,
  type JetStreamManager,
  type ConsumerConfig,
} from '@nats-io/jetstream';
import { Kvm, type KV } from '@nats-io/kv';
import type { NatsConnection } from '@nats-io/nats-core';

// Public re-exports — the rest of the monorepo imports types/enums from here.
export {
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StorageType,
  Kvm,
};
export type { JetStreamClient, JetStreamManager, NatsConnection, KV, ConsumerConfig };

export interface NatsClientOptions {
  url?: string;
}

// Compat shim for the legacy `sc = StringCodec()` pattern.
// In v3 payloads are Uint8Array (or strings directly to publish), but keeping
// this surface unchanged means call sites using `sc.encode(...) / sc.decode(...)`
// don't all have to change in this commit.
const _enc = new TextEncoder();
const _dec = new TextDecoder();
export const sc = {
  encode: (s: string): Uint8Array => _enc.encode(s),
  decode: (u: Uint8Array): string => _dec.decode(u),
};

let _nc: NatsConnection | undefined;

export async function getNatsConnection(): Promise<NatsConnection> {
  if (!_nc) {
    const url = process.env['NATS_URL'] ?? 'nats://localhost:4222';
    _nc = await connect({ servers: url });
  }
  return _nc;
}

export async function createNatsClient(opts?: NatsClientOptions): Promise<NatsConnection> {
  const url = opts?.url ?? process.env['NATS_URL'] ?? 'nats://localhost:4222';
  return connect({ servers: url });
}

export function getJetStream(nc: NatsConnection): JetStreamClient {
  return jetstream(nc);
}

export async function createJetStreamManager(nc: NatsConnection): Promise<JetStreamManager> {
  return jetstreamManager(nc);
}
