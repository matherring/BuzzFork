//! Remove a small set of accidentally resurrected, retired catalog records.
//!
//! These records were published before the catalog retirement and can still be
//! returned by the owner-scoped relay history backfill. They are definitions,
//! not agent instances: removing them must never affect a real agent key or a
//! running process.

use std::path::Path;

/// Historical persona coordinates that must never again become startable
/// definitions. These are stable NIP-33 d-tags, rather than display names, so
/// a user may still create an unrelated agent with the same name.
pub(crate) const RETIRED_PERSONA_D_TAGS: &[&str] = &[
    "3a0db0dd-82d3-48db-8ea1-66bc9ebcaef7", // Reggie
    "bc8c7b06-8fa7-4026-911c-28ea80dd1386", // Dewey
    "e1469eb2-ad25-443d-9b80-c7ca2780f122", // Virgil
    "fc1e1ad8-80df-4c29-85c5-6d2338dcb889", // Repository Steward
];

/// Historical Back Office team coordinate whose membership consists entirely
/// of the retired definitions above.
pub(crate) const RETIRED_TEAM_D_TAG: &str = "b6f01a26-a8a3-4367-a7b4-95e0571d8f39";

pub(crate) fn is_retired_persona_d_tag(d_tag: &str) -> bool {
    RETIRED_PERSONA_D_TAGS.contains(&d_tag)
}

pub(crate) fn is_retired_team_d_tag(d_tag: &str) -> bool {
    d_tag == RETIRED_TEAM_D_TAG
}

/// Remove the historical keyless definitions and team from one dev profile.
///
/// The raw JSON shape is deliberate: boot migrations run before normal store
/// loading, and we only need to identify keyless definition records by their
/// durable coordinates. Keyed records are always preserved.
pub(super) fn purge_retired_catalog_in_dir(base_dir: &Path) -> Result<bool, String> {
    let agents_path = base_dir.join("managed-agents.json");
    let teams_path = base_dir.join("teams.json");
    let mut changed = false;

    if agents_path.exists() {
        let contents = std::fs::read_to_string(&agents_path)
            .map_err(|error| format!("read {}: {error}", agents_path.display()))?;
        let mut records: Vec<serde_json::Value> = serde_json::from_str(&contents)
            .map_err(|error| format!("parse {}: {error}", agents_path.display()))?;
        let before = records.len();
        records.retain(|record| !is_retired_definition(record));
        if records.len() != before {
            let bytes = serde_json::to_vec_pretty(&records)
                .map_err(|error| format!("serialize {}: {error}", agents_path.display()))?;
            crate::managed_agents::atomic_write_json_restricted(&agents_path, &bytes)?;
            changed = true;
        }
    }

    if teams_path.exists() {
        let contents = std::fs::read_to_string(&teams_path)
            .map_err(|error| format!("read {}: {error}", teams_path.display()))?;
        let mut teams: Vec<serde_json::Value> = serde_json::from_str(&contents)
            .map_err(|error| format!("parse {}: {error}", teams_path.display()))?;
        let before = teams.len();
        teams.retain(|team| {
            !team
                .get("id")
                .and_then(serde_json::Value::as_str)
                .is_some_and(is_retired_team_d_tag)
        });
        if teams.len() != before {
            let bytes = serde_json::to_vec_pretty(&teams)
                .map_err(|error| format!("serialize {}: {error}", teams_path.display()))?;
            crate::managed_agents::atomic_write_json(&teams_path, &bytes)?;
            changed = true;
        }
    }

    Ok(changed)
}

fn is_retired_definition(record: &serde_json::Value) -> bool {
    if record.get("pubkey").and_then(serde_json::Value::as_str) != Some("") {
        return false;
    }
    ["slug", "persona_id", "source_team_persona_slug"]
        .iter()
        .filter_map(|field| record.get(*field).and_then(serde_json::Value::as_str))
        .any(is_retired_persona_d_tag)
}

#[cfg(test)]
mod tests {
    use super::purge_retired_catalog_in_dir;

    #[test]
    fn stale_dev_profile_drops_retired_definitions_and_back_office_team() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("managed-agents.json"),
            serde_json::json!([
                {
                    "name": "Reggie",
                    "pubkey": "",
                    "slug": "3a0db0dd-82d3-48db-8ea1-66bc9ebcaef7",
                    "is_active": true
                },
                {
                    "name": "Dewey",
                    "pubkey": "",
                    "slug": "bc8c7b06-8fa7-4026-911c-28ea80dd1386",
                    "is_active": true
                },
                {
                    "name": "Virgil",
                    "pubkey": "",
                    "slug": "e1469eb2-ad25-443d-9b80-c7ca2780f122",
                    "is_active": true
                },
                {
                    "name": "Repository Steward",
                    "pubkey": "",
                    "slug": "fc1e1ad8-80df-4c29-85c5-6d2338dcb889",
                    "is_active": true
                },
                {
                    "name": "Current definition",
                    "pubkey": "",
                    "slug": "current-definition",
                    "is_active": true
                },
                {
                    "name": "Real Reggie instance",
                    "pubkey": "a-real-agent-pubkey",
                    "slug": "3a0db0dd-82d3-48db-8ea1-66bc9ebcaef7"
                }
            ])
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("teams.json"),
            serde_json::json!([
                {
                    "id": "b6f01a26-a8a3-4367-a7b4-95e0571d8f39",
                    "name": "Back Office",
                    "persona_ids": [
                        "3a0db0dd-82d3-48db-8ea1-66bc9ebcaef7",
                        "e1469eb2-ad25-443d-9b80-c7ca2780f122",
                        "bc8c7b06-8fa7-4026-911c-28ea80dd1386",
                        "fc1e1ad8-80df-4c29-85c5-6d2338dcb889"
                    ]
                },
                { "id": "current-team", "name": "Current team", "persona_ids": [] }
            ])
            .to_string(),
        )
        .unwrap();

        assert!(purge_retired_catalog_in_dir(dir.path()).unwrap());

        let agents: Vec<serde_json::Value> = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("managed-agents.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(agents.len(), 2);
        assert!(agents.iter().any(|agent| agent["name"] == "Current definition"));
        assert!(agents.iter().any(|agent| agent["name"] == "Real Reggie instance"));

        let teams: Vec<serde_json::Value> = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("teams.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(teams.len(), 1);
        assert_eq!(teams[0]["id"], "current-team");

        assert!(!purge_retired_catalog_in_dir(dir.path()).unwrap());
    }
}
