import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/release-tauri.yml"),
  "utf8",
);

describe("desktop release workflow", () => {
  it("cannot execute contributor pull-request code with release credentials", () => {
    expect(workflow).not.toMatch(/^\s*pull_request:/m);
    expect(workflow).toContain('on:\n  push:\n    tags: ["v*"]\n  workflow_dispatch:');
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2);
  });

  it("pins every third-party action to an immutable commit", () => {
    const actionReferences = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      // The Rust toolchain installer is consumed through its documented moving channel ref.
      const rustChannel = reference === "dtolnay/rust-toolchain@stable";
      expect(/@[0-9a-f]{40}$/.test(reference) || rustChannel, reference).toBe(true);
    }
  });

  it("signs updater artifacts with release secrets before publishing", () => {
    expect(workflow).toContain("needs: build");
    expect(workflow).toContain(
      "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
    );
    expect(workflow).toContain(
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    );
    expect(workflow).toContain("TAURI_UPDATER_PUBLIC_KEY: ${{ secrets.TAURI_UPDATER_PUBLIC_KEY }}");
    expect(workflow).toContain("createUpdaterArtifacts: true");
  });

  it("pins every platform update feed to the official GitHub owner and repo", () => {
    const endpoints = workflow.match(/https:\/\/github\.com\/[^\s'"]+/g) ?? [];
    expect(endpoints.length).toBeGreaterThan(0);
    for (const endpoint of endpoints) {
      expect(endpoint, endpoint).toMatch(/^https:\/\/github\.com\/alvaropaco\/0xdot\//);
    }
  });

  it("publishes only a complete stable, upgrade-only feed", () => {
    const targets = [...workflow.matchAll(/target: (\S+)$/gm)].map((match) => match[1]);
    expect(targets).toEqual([
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
      "x86_64-unknown-linux-gnu",
      "x86_64-pc-windows-msvc",
    ]);
    expect(workflow).toContain('[[ "$RELEASE_TAG" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]');
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).toContain("fail_on_unmatched_files: true");
    for (const platform of ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"]) {
      expect(workflow).toContain(`"${platform}"`);
    }
  });
});
