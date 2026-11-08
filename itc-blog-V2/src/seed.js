// Fills an EMPTY database with sample data taken from the Figma design, so the frontend has something to show.
// Development only. Usage: npm run seed
import { hashPassword, signReview } from './auth.js';
import { loadConfig } from './config.js';
import { newPublicCode, openDb } from './db.js';
import { refCodeFor, slugify, textStats } from './util.js';

const config = loadConfig();
if (config.nodeEnv === 'production') {
  console.error('Refusing to seed sample data when NODE_ENV=production.');
  process.exit(1);
}

const db = openDb(config.dbPath);
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
  console.error(`This database already has data (${config.dbPath}).`);
  console.error('To start fresh: stop the server, delete that file (and its -wal / -shm files), then run "npm run seed" again.');
  process.exit(1);
}

const PASSWORD = 'Password123!';
const passwordHash = await hashPassword(PASSWORD);
const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

const addUser = (name, email, role, title, bio = '') =>
  Number(
    db
      .prepare('INSERT INTO users (name, email, password_hash, role, title, bio, public_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(name, email, passwordHash, role, title, bio, newPublicCode(db), ago(90)).lastInsertRowid,
  );

const admin = addUser('ITC Admin', 'admin@itc.local', 'admin', 'Editorial Board');
const rev1 = addUser('Walid Khelifi', 'reviewer1@itc.local', 'reviewer', 'Senior Reviewer, Systems');
const rev2 = addUser('Nadia Hamidi', 'reviewer2@itc.local', 'reviewer', 'Reviewer, AI Lab');
const yacine = addUser('Yacine Merabet', 'yacine@itc.local', 'author', 'Systems & Kernel Lead',
  'Senior Computer Science Student at Saad Dahlab Blida 1. Specializing in Linux kernel internals, low-level networking, and high-throughput distributed systems.');
const dana = addUser('Dana Amine', 'dana@itc.local', 'author', 'Principal Systems Lead');
const mehdi = addUser('Mehdi Kadri', 'mehdi@itc.local', 'author', 'DevOps Guild');
const sofiane = addUser('Sofiane Larbi', 'sofiane@itc.local', 'author', 'Security Lead');
const fatima = addUser('Fatima Zahra', 'fatima@itc.local', 'author', 'Storage Engines');
const riad = addUser('Riad Benaissa', 'riad@itc.local', 'author', 'ITC Web Lab');
const othman = addUser('Othman Toumi', 'othman@itc.local', 'author', 'Cloud Distributed Systems');
const mlLead = addUser('ML Research Division', 'ml@itc.local', 'author', 'ITC Labs');

const cat = (slug) => db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug).id;

const sampleBody = (title, subtitle) => `## 1. Context

${subtitle} This write-up documents what we tried, what failed, and what finally worked for the ITC Club cluster at the University of Blida 1.

## 2. Approach

We started from a simple baseline, measured it under realistic load, and changed one thing at a time. Every claim in this article is backed by a benchmark that you can reproduce on your own machine.

\`\`\`go
func main() {
    fmt.Println("${title.replace(/"/g, '')}")
}
\`\`\`

## 3. Results

The final design cut tail latency sharply while keeping the operational footprint small. The main lesson: measure first, optimize second, and write down the numbers.
`;

function addArticle({ author, category, title, subtitle, kind = 'article', status, tags = [], daysAgo = 0, featured = false, views = 0 }) {
  const body = sampleBody(title, subtitle);
  const stats = textStats(body);
  const submitted = status === 'draft' ? null : ago(daysAgo + 3);
  const published = status === 'published' ? ago(daysAgo) : null;
  const id = Number(
    db
      .prepare(
        `INSERT INTO articles (slug, author_id, category_id, kind, title, subtitle, body, tags, status, is_featured,
                               word_count, code_blocks, read_minutes, revision, submitted_at, published_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        slugify(title), author, cat(category), kind, title, subtitle, body, JSON.stringify(tags), status, featured ? 1 : 0,
        stats.wordCount, stats.codeBlocks, stats.readMinutes, status === 'draft' ? 0 : status === 'changes_requested' ? 1 : 1,
        submitted, published, ago(daysAgo + 5), ago(daysAgo),
      ).lastInsertRowid,
  );
  db.prepare('UPDATE articles SET ref_code = ? WHERE id = ?').run(refCodeFor(title, id), id);
  const insertView = db.prepare('INSERT INTO article_views (article_id, viewer_hash, first_viewed_at) VALUES (?, ?, ?)');
  for (let i = 0; i < views; i++) insertView.run(id, `seed:${i}`, ago(Math.max(0, daysAgo - 1)));
  return { id, submitted };
}

function addAssignment(article, reviewer, { priority = 'normal', status = 'assigned', assignedDaysAgo = 1, hoursToFinish = 18 } = {}) {
  const assignedAt = ago(assignedDaysAgo);
  const dueAt = new Date(Date.parse(assignedAt) + config.reviewSlaHours * 3_600_000).toISOString();
  const completedAt = status === 'completed' ? new Date(Date.parse(assignedAt) + hoursToFinish * 3_600_000).toISOString() : null;
  return {
    id: Number(
      db
        .prepare(
          `INSERT INTO review_assignments (article_id, reviewer_id, assigned_by, revision, submitted_at, priority, status, assigned_at, due_at, completed_at)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(article.id, reviewer, admin, article.submitted, priority, status, assignedAt, dueAt, completedAt).lastInsertRowid,
    ),
    completedAt,
  };
}

function addReview(article, assignment, reviewer, decision, feedback) {
  const createdAt = assignment.completedAt;
  const signature = signReview(config, {
    assignmentId: assignment.id, articleId: article.id, revision: 1, reviewerId: reviewer, decision, feedback, createdAt,
  });
  db.prepare(
    `INSERT INTO reviews (assignment_id, article_id, reviewer_id, revision, decision, feedback, signature, created_at)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(assignment.id, article.id, reviewer, decision, feedback, signature, createdAt);
}

// A published or approved article went through one review that approved it.
function approvedByReview(article, reviewer, daysAgo) {
  const assignment = addAssignment(article, reviewer, { status: 'completed', assignedDaysAgo: daysAgo + 2 });
  addReview(article, assignment, reviewer, 'approved', 'Solid work. Approved.');
}

// ---- Published articles (homepage + explore) ----
const published = [
  { author: dana, category: 'software-engineering', kind: 'rfc', title: 'Distributed Raft Consensus in Go: Lessons from Building ITC Portal V4',
    subtitle: 'A deep post-mortem detailing state machine replication, split-brain mitigation, and network partition simulations under high concurrency.',
    tags: ['go', 'raft', 'distributed-systems'], daysAgo: 6, featured: true, views: 42 },
  { author: mlLead, category: 'ai-nlp', kind: 'research-paper', title: 'Fine-Tuning Llama 3 for Algerian Darija NLP',
    subtitle: 'Methodology, LoRA hyperparameters, and synthetic corpus tokenization challenges when fine-tuning multilingual open models.',
    tags: ['llm', 'nlp', 'lora'], daysAgo: 5, featured: true, views: 37 },
  { author: yacine, category: 'devops', title: 'Architecting Low-Latency Real-Time Telemetry with eBPF and Go in Kubernetes',
    subtitle: 'How we bypassed traditional user-space socket overhead to achieve sub-millisecond network tracing across 14 university lab nodes.',
    tags: ['ebpf', 'go', 'kubernetes'], daysAgo: 16, views: 55 },
  { author: mehdi, category: 'devops', title: 'Zero-Downtime Migration to Kubernetes Cilium eBPF CNI',
    subtitle: 'Replacing standard iptables networking with eBPF-powered routing across our bare-metal cluster with zero dropped ingress.',
    tags: ['cilium', 'ebpf'], daysAgo: 4, views: 20 },
  { author: sofiane, category: 'cybersecurity', title: 'Hardening Linux Kernel Memory with Landlock & Seccomp-BPF',
    subtitle: 'Sandboxing student code execution containers inside the ITC online judge platform without the overhead of hardware virtualization.',
    tags: ['linux', 'sandboxing'], daysAgo: 7, views: 18 },
  { author: fatima, category: 'databases', title: 'Postgres B-Tree Bloat: Autovacuum Tuning under Extreme Load',
    subtitle: 'Diagnosing query degradation during member registration spikes, and re-architecting vacuum worker intervals.',
    tags: ['postgres', 'performance'], daysAgo: 12, views: 25 },
  { author: riad, category: 'web-development', title: 'Streaming React Server Components via HTTP/3 Push in Edge Nodes',
    subtitle: 'Measuring sub-millisecond Time-to-First-Byte for Algerian client connections using locally terminated QUIC tunnels.',
    tags: ['react', 'http3'], daysAgo: 18, views: 11 },
  { author: othman, category: 'cloud', title: 'Building a Hybrid On-Prem Object Store with MinIO and Ceph',
    subtitle: 'How we established S3-compliant distributed media caching across two campus data rooms.',
    tags: ['minio', 'ceph', 'storage'], daysAgo: 24, views: 14 },
  { author: yacine, category: 'software-engineering', title: 'Deterministic Concurrency Testing with Rust Model Checking',
    subtitle: 'Hunting subtle race conditions in event-driven club services before deploying code onto our student portal clusters.',
    tags: ['rust', 'testing'], daysAgo: 34, views: 9 },
];
published.forEach((p, i) => {
  const article = addArticle({ ...p, status: 'published' });
  approvedByReview(article, i % 2 === 0 ? rev1 : rev2, p.daysAgo);
});

// ---- Yacine's other manuscripts (My Articles dashboard) ----
const approved = addArticle({ author: yacine, category: 'cloud', status: 'approved', daysAgo: 2,
  title: 'Linux Cgroups v2 & Systemd Slice Orchestration', subtitle: 'Dissecting memory.high vs memory.max triggers under extreme container contention.', tags: ['cgroups', 'linux'] });
approvedByReview(approved, rev1, 2);

const changes = addArticle({ author: yacine, category: 'software-engineering', status: 'changes_requested', daysAgo: 3,
  title: 'Memory Management in High-Throughput Go Workers', subtitle: 'Profiling allocation patterns and arena reuse in write-heavy services.', tags: ['go', 'memory'] });
addReview(changes, addAssignment(changes, rev1, { status: 'completed', assignedDaysAgo: 3, hoursToFinish: 20 }), rev1,
  'changes_requested', 'Excellent analysis. In Section 3, please list the Go version and GC settings used, and add a short warning about arena reuse.');

addArticle({ author: yacine, category: 'web-development', status: 'draft', daysAgo: 1,
  title: 'Exploring WebGPU Compute Shaders for Graph Neural Nets', subtitle: 'Writing custom WGSL shaders to execute message-passing passes directly on client GPUs.', tags: ['webgpu'] });

// ---- Review pipeline (reviewer queue + admin queue) ----
const quant = addArticle({ author: yacine, category: 'ai-nlp', status: 'pending_review', daysAgo: 2,
  title: 'Quantization Horizons: AWQ vs FP8 Inference on Edge GPUs', subtitle: 'Evaluating throughput thresholds, activation anomalies, and memory bandwidth bounds.', tags: ['gpu', 'llm'] });
addAssignment(quant, rev2, { priority: 'high', assignedDaysAgo: 2 });

const wireguard = addArticle({ author: mehdi, category: 'cloud', status: 'pending_review', daysAgo: 1,
  title: 'Automating Multi-Region WireGuard Mesh Networks', subtitle: 'Dynamic topology negotiation using custom etcd state syncing and automated MTU discovery.', tags: ['wireguard', 'etcd'] });
// First reviewer sent it back ("outside my expertise"), so the admin gave it to reviewer 2.
const sentBack = addAssignment(wireguard, rev1, { status: 'returned', assignedDaysAgo: 2 });
db.prepare('UPDATE review_assignments SET returned_at = ?, return_reason = ?, suggested_expertise = ? WHERE id = ?').run(
  ago(1), 'I mostly work on application code, and this paper is deep network engineering.', 'Networking / Cloud infrastructure', sentBack.id,
);
addAssignment(wireguard, rev2, { assignedDaysAgo: 1 });

addArticle({ author: sofiane, category: 'cybersecurity', status: 'pending_review', daysAgo: 0,
  title: 'Kernel-Level Packet Filtering with XDP in C', subtitle: 'Zero-copy ingress filtering directly in device driver hook layers for real-time DDoS mitigation.', tags: ['xdp', 'ddos'] });

console.log('Seeded sample data.\n');
console.log(`All accounts use the password: ${PASSWORD}\n`);
console.log('  admin@itc.local       admin     (assigns reviewers, features/publishes articles)');
console.log('  reviewer1@itc.local   reviewer');
console.log('  reviewer2@itc.local   reviewer  (has 2 manuscripts waiting in the queue)');
console.log('  yacine@itc.local      author    (has a draft, pending, changes-requested, approved and published articles)');
console.log('  mehdi@itc.local, dana@itc.local, ...  authors');
db.close();
