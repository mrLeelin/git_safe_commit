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
