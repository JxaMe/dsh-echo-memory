#!/usr/bin/env node
/**
 * 核心定位边界检查：
 * 极简、纯本地、无向量、无数据库。
 * 任何违反边界的改动都会让本脚本失败。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const errors = []

// 1. 依赖黑名单：数据库 / 向量库 / 外部服务客户端
const dependencyBlacklist = [
  /sqlite|postgres|mysql|maria|redis|mongo|clickhouse|dynamodb|elastic|meilisearch|qdrant|weaviate|faiss|hnsw|leveldb|rocksdb|neo4j|arangodb|oracle|mssql|pg\b/i,
  /embedding|vector|vectordb|chroma|pinecone|milvus|pgvector/i,
]

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
for (const [name] of Object.entries(pkg.dependencies ?? {})) {
  if (dependencyBlacklist.some(re => re.test(name))) {
    errors.push(`dependency violates boundary: ${name}`)
  }
}

// 2. 存储边界：仍然只有 memory.json 单表，schema 不得重新引入向量字段
const domain = readFileSync(join(root, 'src/domain.ts'), 'utf8')
if (/\bembedding\s*[:?]/.test(domain) || /\bembeddingAt\s*[:?]/.test(domain)) {
  errors.push('domain schema reintroduced embedding/embeddingAt')
}
const tableCount = [...domain.matchAll(/domainTable\s*[<(]/g)].length
if (tableCount !== 1) {
  errors.push(`expected exactly 1 domainTable, found ${tableCount}`)
}

// 3. 源码不得新增数据库/向量导入（历史迁移注释允许出现 embedding 字样）
const blacklistImports = [
  /from\s+['"](?:better-sqlite3|sqlite3|pg|mysql2|redis|mongodb|@?qdrant|@?weaviate|@?chroma|@?pinecone|faiss|hnswlib)/i,
  /from\s+['"][^'"]*(?:vector|embedding)[^'"]*['"]/i,
]

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'lib') continue
      walk(full)
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      const rel = relative(root, full)
      const src = readFileSync(full, 'utf8')
      for (const re of blacklistImports) {
        if (re.test(src)) {
          errors.push(`source import violates boundary: ${rel}`)
          break
        }
      }
    }
  }
}
walk(join(root, 'src'))

if (errors.length > 0) {
  console.error('Boundary check failed:')
  for (const err of errors) console.error(`- ${err}`)
  process.exit(1)
}

console.log('Boundary check passed: 极简 / 纯本地 / 无向量 / 无数据库')
