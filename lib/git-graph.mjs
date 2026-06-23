import { runGit } from "./git-executor.mjs";

export function buildGraphLogArgs() {
  return ["log", "--graph", "--topo-order", "--decorate", "--oneline", "--all", "-n", "60"];
}

export function buildCommitLogArgs() {
  return [
    "log",
    "--all",
    "--topo-order",
    "--decorate=short",
    "--date=short",
    "--pretty=format:%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%s%x1f%ad",
    "-n",
    "80"
  ];
}

export async function getGitGraph(repoPath) {
  const graphResult = await runGit(repoPath, buildGraphLogArgs());
  const commitResult = await runGit(repoPath, buildCommitLogArgs());
  return {
    ok: true,
    graph: graphResult.stdout.split(/\r?\n/).filter(Boolean),
    commits: parseCommitGraph(commitResult.stdout),
    command: graphResult.command,
    stderr: graphResult.stderr || commitResult.stderr
  };
}

export function parseCommitGraph(stdout) {
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [hash, shortHash, parents, refs, author, subject, date] = line.split("\x1f");
    const parsedRefs = parseRefs(refs || "");
    return {
      hash,
      shortHash,
      parents: parents ? parents.split(/\s+/).filter(Boolean) : [],
      refs: parsedRefs.refs,
      author,
      subject,
      date,
      isHead: Boolean(parsedRefs.current)
    };
  });
}

export function parseRefs(refs) {
  let current = "";
  const parsed = refs
    .split(",")
    .map((ref) => ref.trim())
    .filter(Boolean)
    .map((ref) => {
      const match = /^HEAD -> (.+)$/.exec(ref);
      if (match) {
        current = match[1];
        return current;
      }
      return ref.replace(/^origin\//, "origin/");
    });
  return { current, refs: [...new Set(parsed)] };
}

export async function getCommitDetail(repoPath, hash) {
  const result = await runGit(repoPath, [
    "show",
    "--format=%H%n%h%n%P%n%D%n%an%n%ae%n%ad%n%s%n%B",
    "--name-status",
    "--date=iso",
    hash
  ]);
  if (!result.ok) throw new Error(result.stderr || `commit ${hash} not found`);

  const lines = result.stdout.split(/\r?\n/);
  const [fullHash, shortHash, parentsLine, refsLine, author, authorEmail, date, subject] = lines.slice(0, 9);
  const bodyLines = [];
  let i = 9;
  while (i < lines.length && lines[i] !== "") {
    bodyLines.push(lines[i]);
    i += 1;
  }
  i += 1;

  const files = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line) {
      const parts = line.split("\t");
      files.push({ status: parts[0] || "", path: parts.at(-1) || "" });
    }
    i += 1;
  }

  return {
    ok: true,
    commit: {
      hash: fullHash,
      shortHash,
      parents: parentsLine ? parentsLine.split(/\s+/).filter(Boolean) : [],
      refs: parseRefs(refsLine || "").refs,
      author,
      authorEmail,
      date,
      subject,
      body: bodyLines.join("\n"),
      files
    }
  };
}
