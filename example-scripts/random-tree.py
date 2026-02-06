#!/usr/bin/env python3
"""Generate a random directory tree populated with .txt and .md files."""

import argparse
import os
import random
import sys
from dataclasses import dataclass, field

FALLBACK_WORDS = [
    "apple", "banana", "cherry", "delta", "echo", "falcon", "grape", "harbor",
    "island", "jungle", "kettle", "lantern", "marble", "nectar", "olive",
    "pebble", "quartz", "river", "sunset", "timber", "umbrella", "valley",
    "willow", "yellow", "zephyr", "bridge", "castle", "dolphin", "engine",
    "forest", "garden", "hammer", "ivory", "jasper", "kitten", "lemon",
    "mirror", "nimble", "orange", "parrot", "quiver", "ribbon", "silver",
    "temple", "unique", "violet", "winter", "crystal", "dragon", "feather",
    "gentle", "hollow", "insect", "jigsaw", "kernel", "little", "meadow",
    "narrow", "oyster", "pillow", "rabbit", "saddle", "travel", "useful",
    "velvet", "wander", "anchor", "breeze", "candle", "dimple", "elbow",
    "frozen", "goblet", "humble", "ignite", "jovial", "knobby", "lizard",
    "muffin", "noodle", "paddle", "quaint", "rustic", "simple", "throne",
    "urchin", "vivid", "walnut", "branch", "clover", "dagger", "ember",
    "floral", "gravel", "hidden", "indigo", "jumble", "kindly", "locket",
    "mosaic", "nutmeg", "orchid", "plunge", "riddle", "spiral", "trophy",
]


def parse_args():
    parser = argparse.ArgumentParser(
        description="Generate a random directory tree with text files.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("output_dir", help="Root directory for generated tree")
    parser.add_argument("--weight-file", type=float, default=5.0,
                        help="Weight for creating a file")
    parser.add_argument("--weight-dir", type=float, default=3.0,
                        help="Weight for creating a subdirectory")
    parser.add_argument("--weight-finish", type=float, default=3.0,
                        help="Weight for finishing current directory")
    parser.add_argument("--max-depth", type=int, default=4,
                        help="Maximum nesting depth")
    parser.add_argument("--max-files", type=int, default=50,
                        help="Hard cap on total files")
    parser.add_argument("--min-words", type=int, default=20,
                        help="Minimum words per file")
    parser.add_argument("--max-words", type=int, default=200,
                        help="Maximum words per file")
    parser.add_argument("--md-ratio", type=float, default=0.3,
                        help="Probability a file is .md vs .txt")
    parser.add_argument("--dictionary", type=str,
                        default="/usr/share/dict/words",
                        help="Dictionary file path")
    parser.add_argument("--seed", type=int, default=None,
                        help="Random seed for reproducibility")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="Print actions to stderr")

    args = parser.parse_args()

    # Validation
    if args.weight_file < 0 or args.weight_dir < 0 or args.weight_finish < 0:
        parser.error("Weights must be non-negative.")
    if args.weight_file + args.weight_dir <= 0:
        parser.error("At least one of --weight-file or --weight-dir must be positive.")
    if not 0 <= args.md_ratio <= 1:
        parser.error("--md-ratio must be in [0, 1].")
    if args.min_words > args.max_words:
        parser.error("--min-words must be <= --max-words.")
    if args.max_files < 1:
        parser.error("--max-files must be >= 1.")

    return args


def load_words(dictionary_path):
    try:
        with open(dictionary_path) as f:
            words = [
                line.strip() for line in f
                if line.strip().isalpha()
                and line.strip().islower()
                and 3 <= len(line.strip()) <= 12
            ]
        if len(words) >= 50:
            return words
    except OSError:
        pass
    return list(FALLBACK_WORDS)


def generate_name(rng, words, num_parts=None):
    if num_parts is None:
        num_parts = rng.randint(1, 2)
    return "-".join(rng.choice(words) for _ in range(num_parts))


def resolve_collision(base_path):
    if not os.path.exists(base_path):
        return base_path
    root, ext = os.path.splitext(base_path)
    counter = 2
    while True:
        candidate = f"{root}-{counter}{ext}"
        if not os.path.exists(candidate):
            return candidate
        counter += 1


def make_sentences(rng, words, target_word_count):
    result = []
    remaining = target_word_count
    while remaining > 0:
        length = min(rng.randint(5, 15), remaining)
        sentence_words = [rng.choice(words) for _ in range(length)]
        sentence_words[0] = sentence_words[0].capitalize()
        result.append(" ".join(sentence_words) + ".")
        remaining -= length
    return result


def generate_plaintext(rng, words, min_words, max_words):
    total_words = rng.randint(min_words, max_words)
    sentences = make_sentences(rng, words, total_words)
    paragraphs = []
    current = []
    word_count = 0
    para_limit = rng.randint(20, 60)
    for sentence in sentences:
        current.append(sentence)
        word_count += len(sentence.split())
        if word_count >= para_limit:
            paragraphs.append(" ".join(current))
            current = []
            word_count = 0
            para_limit = rng.randint(20, 60)
    if current:
        paragraphs.append(" ".join(current))
    return "\n\n".join(paragraphs) + "\n"


def generate_markdown(rng, words, min_words, max_words):
    total_words = rng.randint(min_words, max_words)
    title = " ".join(rng.choice(words).capitalize() for _ in range(rng.randint(2, 5)))
    lines = [f"# {title}", ""]
    remaining = total_words

    while remaining > 0:
        # Choose section type: paragraph, heading+paragraph, bullet list, numbered list
        section_type = rng.choices(
            ["paragraph", "heading", "bullets", "numbered"],
            weights=[5, 2, 2, 1],
        )[0]

        if section_type == "heading":
            level = rng.choice(["##", "###"])
            heading_text = " ".join(
                rng.choice(words).capitalize() for _ in range(rng.randint(2, 4))
            )
            lines.append(f"{level} {heading_text}")
            lines.append("")

        chunk_words = min(rng.randint(15, 50), remaining)

        if section_type in ("paragraph", "heading"):
            sentences = make_sentences(rng, words, chunk_words)
            lines.append(" ".join(sentences))
            lines.append("")
        elif section_type == "bullets":
            items = rng.randint(3, 6)
            words_per_item = max(chunk_words // items, 1)
            for _ in range(items):
                item_words = [rng.choice(words) for _ in range(words_per_item)]
                item_words[0] = item_words[0].capitalize()
                lines.append(f"- {' '.join(item_words)}")
            lines.append("")
        elif section_type == "numbered":
            items = rng.randint(3, 6)
            words_per_item = max(chunk_words // items, 1)
            for i in range(items):
                item_words = [rng.choice(words) for _ in range(words_per_item)]
                item_words[0] = item_words[0].capitalize()
                lines.append(f"{i + 1}. {' '.join(item_words)}")
            lines.append("")

        remaining -= chunk_words

    return "\n".join(lines)


@dataclass
class TreeState:
    files_created: int = 0
    dirs_created: int = 0
    max_depth_reached: int = 0
    txt_count: int = 0
    md_count: int = 0


def populate_directory(path, depth, args, rng, words, state):
    os.makedirs(path, exist_ok=True)
    if depth > state.max_depth_reached:
        state.max_depth_reached = depth

    first_iteration = True
    while state.files_created < args.max_files:
        # Build action weights
        actions = []
        weights = []

        actions.append("file")
        weights.append(args.weight_file)

        if depth < args.max_depth:
            actions.append("dir")
            weights.append(args.weight_dir)

        if not first_iteration:
            actions.append("finish")
            weights.append(args.weight_finish)

        first_iteration = False

        if not any(w > 0 for w in weights):
            break

        action = rng.choices(actions, weights=weights)[0]

        if action == "file":
            is_md = rng.random() < args.md_ratio
            ext = ".md" if is_md else ".txt"
            name = generate_name(rng, words) + ext
            file_path = resolve_collision(os.path.join(path, name))

            if is_md:
                content = generate_markdown(rng, words, args.min_words, args.max_words)
            else:
                content = generate_plaintext(rng, words, args.min_words, args.max_words)

            with open(file_path, "w") as f:
                f.write(content)

            state.files_created += 1
            if is_md:
                state.md_count += 1
            else:
                state.txt_count += 1

            if args.verbose:
                rel = os.path.relpath(file_path, args.output_dir)
                print(f"  FILE {rel}", file=sys.stderr)

        elif action == "dir":
            dir_name = generate_name(rng, words)
            dir_path = resolve_collision(os.path.join(path, dir_name))
            state.dirs_created += 1

            if args.verbose:
                rel = os.path.relpath(dir_path, args.output_dir)
                print(f"  DIR  {rel}/", file=sys.stderr)

            populate_directory(dir_path, depth + 1, args, rng, words, state)

        elif action == "finish":
            break


def main():
    args = parse_args()
    rng = random.Random(args.seed)
    words = load_words(args.dictionary)

    if args.verbose:
        print(f"Loaded {len(words)} dictionary words.", file=sys.stderr)
        print(f"Building tree in {args.output_dir} ...", file=sys.stderr)

    state = TreeState()
    # The root itself is not counted as a created directory
    populate_directory(args.output_dir, 0, args, rng, words, state)

    print(
        f"Generated tree in {args.output_dir}:\n"
        f"  Files: {state.files_created} "
        f"({state.txt_count} .txt, {state.md_count} .md)\n"
        f"  Directories: {state.dirs_created}\n"
        f"  Max depth reached: {state.max_depth_reached}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
