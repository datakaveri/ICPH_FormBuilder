"""Download a pinned Hugging Face model snapshot into a local asset directory."""

from __future__ import annotations

import argparse
from pathlib import Path

from huggingface_hub import snapshot_download


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    snapshot_download(
        repo_id=args.repo,
        revision=args.revision,
        local_dir=args.output,
    )


if __name__ == "__main__":
    main()
