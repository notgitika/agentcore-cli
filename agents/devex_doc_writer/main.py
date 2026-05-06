#!/usr/bin/env python3
"""
DevEx Doc Writer — Entry Point

Orchestrates the DevEx doc generation pipeline:
1. Parse and validate inputs (YAML)
2. Refresh knowledge snapshot
3. Load knowledge context
4. Validate analogue choice
5. Propose inferred decisions (wait for human confirmation)
6. Write DevEx doc (writer prompt + template)
7. Self-review (14-point checklist)
8. Iterative review loop (until APPROVED)
9. Output final doc + impl plan skeleton

Usage:
  python main.py --input input.yaml
  python main.py --input input.yaml --skip-refresh

Requires: PR #1124 core/ infrastructure for Harness invocation.
Standalone mode: runs locally with direct LLM calls (no Harness).
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path

import yaml

# ─── Constants ────────────────────────────────────────────────────────────────

AGENTS_ROOT = Path(__file__).parent.parent
KNOWLEDGE_DIR = AGENTS_ROOT / "knowledge"
PROMPTS_DIR = Path(__file__).parent / "prompts"
TEMPLATES_DIR = Path(__file__).parent / "templates"
ARCHETYPES_DIR = Path(__file__).parent / "archetypes"
INPUTS_SCHEMA = Path(__file__).parent / "inputs" / "schema.yaml"

VALID_ARCHETYPES = ["new_resource", "scope_widening"]
APPROVAL_KEYWORD = "APPROVED"


# ─── Input Parsing ────────────────────────────────────────────────────────────


def load_inputs(input_path: str) -> dict:
    """Load and parse YAML input file."""
    path = Path(input_path)
    if not path.exists():
        print(f"[error] Input file not found: {path}")
        sys.exit(1)

    with open(path) as f:
        inputs = yaml.safe_load(f)

    if not isinstance(inputs, dict):
        print("[error] Input file must be a YAML object")
        sys.exit(1)

    return inputs


def validate_inputs(inputs: dict) -> list[str]:
    """
    Validate inputs against the schema.
    Returns list of error messages (empty = valid).
    """
    errors = []

    # Check archetype
    archetype = inputs.get("archetype")
    if not archetype:
        # Try to infer
        if "control_plane_operations" in inputs:
            inputs["archetype"] = "new_resource"
        elif "current_description" in inputs or "affected_commands" in inputs:
            inputs["archetype"] = "scope_widening"
        else:
            errors.append("'archetype' is required (new_resource or scope_widening)")
            return errors

    if inputs["archetype"] not in VALID_ARCHETYPES:
        errors.append(f"'archetype' must be one of {VALID_ARCHETYPES}")
        return errors

    # Common required fields
    common_required = [
        "feature_name",
        "feature_slug",
        "feature_description",
        "service_team",
        "service_team_contact",
        "target_repo",
        "target_cdk_repo",
        "sensitivity_level",
        "allowlisted_account_id",
        "allowlisted_regions",
    ]

    for field in common_required:
        if field not in inputs or not inputs[field]:
            errors.append(f"Required field missing: '{field}'")

    # Validate account ID format
    account_id = inputs.get("allowlisted_account_id", "")
    if account_id and (len(str(account_id)) != 12 or not str(account_id).isdigit()):
        errors.append("'allowlisted_account_id' must be a 12-digit number")

    # Validate slug format
    slug = inputs.get("feature_slug", "")
    if slug:
        import re
        if not re.match(r"^[a-z][a-z0-9-]*$", slug):
            errors.append("'feature_slug' must be kebab-case (lowercase, hyphens, starts with letter)")

    # Sensitivity check
    if inputs.get("sensitivity_level") == "internal" and inputs.get("target_repo") == "public":
        if not inputs.get("public_feature_name"):
            errors.append("'public_feature_name' required when sensitivity=internal and target_repo=public")

    # SDK package check
    if inputs.get("sdk_available") and not inputs.get("sdk_package_name"):
        errors.append("'sdk_package_name' required when sdk_available=true")

    # Archetype-specific validation
    if inputs["archetype"] == "new_resource":
        errors.extend(_validate_new_resource(inputs))
    elif inputs["archetype"] == "scope_widening":
        errors.extend(_validate_scope_widening(inputs))

    return errors


def _validate_new_resource(inputs: dict) -> list[str]:
    """Validate new_resource-specific fields."""
    errors = []
    required = [
        "api_source",
        "api_reference",
        "control_plane_service",
        "control_plane_operations",
        "trust_policy",
        "service_principal",
        "required_permissions",
        "cfn_support",
        "cli_verb",
        "tui_flow",
        "supports_remove",
        "closest_primitive_analogue",
        "analogue_rationale",
    ]

    for field in required:
        if field not in inputs:
            errors.append(f"Required for new_resource: '{field}'")

    # Validate trust policy structure
    trust_policy = inputs.get("trust_policy", {})
    if trust_policy:
        if "Statement" not in trust_policy or not trust_policy["Statement"]:
            errors.append("'trust_policy' must have at least one Statement")
        else:
            for stmt in trust_policy["Statement"]:
                if "Principal" not in stmt:
                    errors.append("Each trust_policy Statement must have a Principal")

    # Validate operations
    ops = inputs.get("control_plane_operations", [])
    if ops:
        mutating_methods = {"POST", "PUT", "DELETE", "PATCH"}
        has_mutating = any(op.get("http_method") in mutating_methods for op in ops)
        if not has_mutating:
            errors.append("'control_plane_operations' must include at least one mutating operation (POST/PUT/DELETE)")

    # CFN conditional requirements
    if inputs.get("cfn_support"):
        if not inputs.get("cfn_resource_type"):
            errors.append("'cfn_resource_type' required when cfn_support=true")
        if not inputs.get("cfn_outputs"):
            errors.append("'cfn_outputs' required when cfn_support=true")

    return errors


def _validate_scope_widening(inputs: dict) -> list[str]:
    """Validate scope_widening-specific fields."""
    errors = []
    required = [
        "current_description",
        "current_key_files",
        "current_user_experience",
        "target_description",
        "coexistence_model",
        "backwards_compatible",
        "affected_commands",
        "closest_scope_widening_analogue",
        "analogue_rationale",
    ]

    for field in required:
        if field not in inputs:
            errors.append(f"Required for scope_widening: '{field}'")

    # Backwards compat check
    if inputs.get("backwards_compatible") is False and not inputs.get("migration_plan"):
        errors.append("'migration_plan' required when backwards_compatible=false")

    # Coexistence model validation
    valid_models = ["user_chooses_one", "stacked", "migration"]
    if inputs.get("coexistence_model") and inputs["coexistence_model"] not in valid_models:
        errors.append(f"'coexistence_model' must be one of {valid_models}")

    return errors


# ─── Knowledge ────────────────────────────────────────────────────────────────


def refresh_knowledge(skip: bool = False) -> bool:
    """Run the knowledge snapshot refresh script."""
    if skip:
        print("[info] Skipping knowledge refresh (--skip-refresh)")
        return True

    refresh_script = KNOWLEDGE_DIR / "refresh.ts"
    if not refresh_script.exists():
        print(f"[warn] refresh.ts not found at {refresh_script}")
        return False

    print("[info] Refreshing knowledge snapshot...")
    try:
        result = subprocess.run(
            ["npx", "tsx", "refresh.ts", "--cli-root", "../../"],
            cwd=KNOWLEDGE_DIR,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            print(f"[warn] Refresh failed: {result.stderr}")
            print("[warn] Using cached snapshot (may be stale)")
            return True  # non-fatal — use cached
        print(result.stdout.strip())
        return True
    except subprocess.TimeoutExpired:
        print("[warn] Refresh timed out. Using cached snapshot.")
        return True
    except FileNotFoundError:
        print("[warn] npx/tsx not found. Using cached snapshot.")
        return True


def load_knowledge() -> dict:
    """Load the knowledge snapshots."""
    context = {}

    cli_snapshot = KNOWLEDGE_DIR / "cli-architecture-snapshot.yaml"
    cdk_snapshot = KNOWLEDGE_DIR / "cdk-architecture-snapshot.yaml"

    if cli_snapshot.exists():
        with open(cli_snapshot) as f:
            context["cli"] = yaml.safe_load(f)
        print(f"[info] CLI snapshot loaded (commit: {context['cli'].get('commit', 'unknown')})")
    else:
        print("[warn] CLI snapshot not found. Run: cd agents/knowledge && npm run refresh")
        context["cli"] = {}

    if cdk_snapshot.exists():
        with open(cdk_snapshot) as f:
            context["cdk"] = yaml.safe_load(f)
        print(f"[info] CDK snapshot loaded (commit: {context['cdk'].get('commit', 'unknown')})")
    else:
        print("[warn] CDK snapshot not found.")
        context["cdk"] = {}

    return context


def validate_analogue(inputs: dict, knowledge: dict) -> list[str]:
    """Check that the user's analogue choice exists in the snapshot."""
    warnings = []
    cli = knowledge.get("cli", {})
    primitives = cli.get("primitives", [])
    primitive_kinds = [p.get("kind") for p in primitives]

    if inputs.get("archetype") == "new_resource":
        analogue = inputs.get("closest_primitive_analogue", "")
        if analogue and analogue not in primitive_kinds:
            warnings.append(
                f"Analogue '{analogue}' not found in snapshot. "
                f"Available: {', '.join(primitive_kinds)}"
            )

    return warnings


def check_slug_collision(inputs: dict, knowledge: dict) -> list[str]:
    """Check that feature_slug doesn't collide with existing resources."""
    warnings = []
    cli = knowledge.get("cli", {})
    slug = inputs.get("feature_slug", "")

    # Check schema arrays
    schema_keys = [
        arr.get("key", "")
        for arr in cli.get("schema_shape", {}).get("agentcore_json", {}).get("top_level_arrays", [])
    ]
    if slug in schema_keys or slug.replace("-", "") in [k.lower() for k in schema_keys]:
        warnings.append(f"feature_slug '{slug}' may collide with existing schema key")

    # Check command nouns
    for verb in cli.get("commands", {}).get("verbs", []):
        nouns = verb.get("nouns", [])
        if slug in nouns:
            warnings.append(f"feature_slug '{slug}' collides with existing command noun in '{verb['name']}'")

    return warnings


# ─── Prompt Assembly ──────────────────────────────────────────────────────────


def load_prompt(name: str) -> str:
    """Load a prompt file by name."""
    path = PROMPTS_DIR / f"{name}.md"
    if not path.exists():
        print(f"[error] Prompt not found: {path}")
        sys.exit(1)
    return path.read_text()


def load_template(archetype: str, stage: str = "devex") -> str:
    """Load the appropriate template for the archetype."""
    if stage == "devex":
        filename = f"{archetype.replace('_', '-')}-devex.md"
    else:
        filename = "implementation-plan.md"

    path = TEMPLATES_DIR / filename
    if not path.exists():
        print(f"[error] Template not found: {path}")
        sys.exit(1)
    return path.read_text()


def assemble_writer_context(inputs: dict, knowledge: dict) -> str:
    """
    Build the full context string passed to the writer agent.
    Combines: system prompt + knowledge snapshot + inputs + template.
    """
    writer_prompt = load_prompt("writer")
    template = load_template(inputs["archetype"])

    # Build context
    context_parts = [
        writer_prompt,
        "\n---\n\n## Knowledge Snapshot\n\n```yaml\n",
        yaml.dump(knowledge.get("cli", {}), default_flow_style=False),
        "```\n\n",
        "## CDK Snapshot\n\n```yaml\n",
        yaml.dump(knowledge.get("cdk", {}), default_flow_style=False),
        "```\n\n",
        "## User Inputs\n\n```yaml\n",
        yaml.dump(inputs, default_flow_style=False),
        "```\n\n",
        "## Template\n\n",
        template,
    ]

    return "".join(context_parts)


# ─── Main Pipeline ────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="DevEx Doc Writer Pipeline")
    parser.add_argument("--input", required=True, help="Path to input YAML file")
    parser.add_argument("--skip-refresh", action="store_true", help="Skip knowledge snapshot refresh")
    parser.add_argument("--output-dir", default="./output", help="Directory for output files")
    parser.add_argument("--dry-run", action="store_true", help="Validate inputs and exit (no generation)")
    args = parser.parse_args()

    print("=" * 60)
    print("  DevEx Doc Writer Pipeline")
    print("=" * 60)
    print()

    # 1. Load inputs
    print("[step 1/7] Loading inputs...")
    inputs = load_inputs(args.input)
    print(f"  Feature: {inputs.get('feature_name', '?')}")
    print(f"  Archetype: {inputs.get('archetype', 'auto-detect')}")
    print()

    # 2. Validate inputs
    print("[step 2/7] Validating inputs...")
    errors = validate_inputs(inputs)
    if errors:
        print(f"  [FAIL] {len(errors)} validation error(s):")
        for err in errors:
            print(f"    - {err}")
        sys.exit(1)
    print(f"  [PASS] All required fields present (archetype: {inputs['archetype']})")
    print()

    # 3. Refresh knowledge
    print("[step 3/7] Refreshing knowledge...")
    refresh_knowledge(skip=args.skip_refresh)
    print()

    # 4. Load knowledge
    print("[step 4/7] Loading knowledge context...")
    knowledge = load_knowledge()
    print()

    # 5. Validate analogue and check collisions
    print("[step 5/7] Validating against snapshot...")
    analogue_warnings = validate_analogue(inputs, knowledge)
    collision_warnings = check_slug_collision(inputs, knowledge)

    all_warnings = analogue_warnings + collision_warnings
    if all_warnings:
        print(f"  [WARN] {len(all_warnings)} warning(s):")
        for w in all_warnings:
            print(f"    - {w}")
    else:
        print("  [PASS] No collisions, analogue valid")
    print()

    if args.dry_run:
        print("[dry-run] Validation complete. Exiting without generation.")
        print()
        print("Next step: remove --dry-run to generate the DevEx doc.")
        sys.exit(0)

    # 6. Assemble writer context
    print("[step 6/7] Assembling writer context...")
    writer_context = assemble_writer_context(inputs, knowledge)
    print(f"  Context size: {len(writer_context):,} chars")
    print()

    # 7. Output
    print("[step 7/7] Writing output...")
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Write the assembled context (ready for Harness invocation or direct LLM call)
    context_path = output_dir / "writer-context.md"
    context_path.write_text(writer_context)
    print(f"  Writer context: {context_path}")

    # Write the self-reviewer prompt
    reviewer_prompt = load_prompt("self_reviewer")
    reviewer_path = output_dir / "self-reviewer-prompt.md"
    reviewer_path.write_text(reviewer_prompt)
    print(f"  Self-reviewer prompt: {reviewer_path}")

    # Write inputs summary
    summary_path = output_dir / "inputs-validated.yaml"
    with open(summary_path, "w") as f:
        yaml.dump(inputs, f, default_flow_style=False)
    print(f"  Validated inputs: {summary_path}")

    print()
    print("=" * 60)
    print("  Pipeline ready.")
    print()
    print("  To generate the DevEx doc, invoke the writer agent with:")
    print(f"    {context_path}")
    print()
    print("  With PR #1124 core/:")
    print("    uv run agents/devex_doc_writer/main.py --input input.yaml")
    print("    (auto-invokes Harness with writer context)")
    print()
    print("  Standalone (direct LLM):")
    print("    Pass writer-context.md as the system prompt to your LLM of choice.")
    print("    The doc will be generated following the template + tenets.")
    print("=" * 60)


if __name__ == "__main__":
    main()
