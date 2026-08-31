/**
 * 测试用领域表假实现：内存 Map 模拟 KvTable 契约（get/entries/keys/size/put/delete/update），
 * 用于隔离 MemoryStore 的纯逻辑测试。
 */

import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

export class FakeKvTable<K extends string, V> implements KvTable<K, V> {
  private readonly records = new Map<K, V>()

  get(key: K): V | undefined {
    return this.records.get(key)
  }

  entries(): IterableIterator<[K, V]> {
    return this.records.entries()
  }

  keys(): IterableIterator<K> {
    return this.records.keys()
  }

  get size(): number {
    return this.records.size
  }

  async put(key: K, value: V): Promise<void> {
    this.records.set(key, value)
  }

  async delete(key: K): Promise<boolean> {
    return this.records.delete(key)
  }

  async update(key: K, fn: (value: V) => V): Promise<V> {
    const current = this.records.get(key)
    if (current === undefined) {
      throw new Error('missing-key')
    }
    const next = fn(current)
    this.records.set(key, next)
    return next
  }
}