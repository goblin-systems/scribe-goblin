use crate::db::{self, entry_select_columns_with_prefix, row_to_entry, DbState, EntryRow};
use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use tauri::State as TauriState;

const PREFIX_SEARCH_EXPANSION: i64 = 4;
const FUZZY_SEARCH_EXPANSION: i64 = 6;
const MAX_FUZZY_DISTANCE: usize = 2;

#[derive(Debug, Clone)]
struct PrefixMatchCandidate {
    entry: EntryRow,
    matched_terms: Vec<String>,
    quality_penalty: i64,
}

#[derive(Debug, Clone)]
struct FuzzyTermMatch {
    query_term: String,
    matched_term: String,
    distance: usize,
}

#[derive(Debug, Clone)]
struct FuzzyMatchCandidate {
    entry: EntryRow,
    matches: Vec<FuzzyTermMatch>,
    total_distance: usize,
    similarity: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SearchFilters {
    pub scope: Option<String>,
    pub source: Option<String>,
    #[serde(alias = "collectionId")]
    pub collection_id: Option<String>,
    #[serde(alias = "sourceApp")]
    pub source_app: Option<String>,
    pub tag: Option<String>,
    #[serde(alias = "relatedTo")]
    pub related_to: Option<String>,
    #[serde(alias = "dateFrom")]
    pub date_from: Option<i64>,
    #[serde(alias = "dateTo")]
    pub date_to: Option<i64>,
    #[serde(alias = "isNote")]
    pub is_note: Option<bool>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SearchMode {
    #[default]
    Keyword,
    Semantic,
    Hybrid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchDiagnostics {
    pub query_text: Option<String>,
    pub fts_query: Option<String>,
    pub applied_filters: Vec<String>,
    pub bm25: Option<f64>,
    pub search_mode: Option<SearchMode>,
    pub cosine_similarity: Option<f64>,
    pub semantic_fallback_reason: Option<String>,
    pub keyword_rank: Option<i64>,
    pub semantic_rank: Option<i64>,
    pub keyword_weight: Option<f64>,
    pub semantic_weight: Option<f64>,
    pub keyword_rrf_score: Option<f64>,
    pub semantic_rrf_score: Option<f64>,
    pub recency_max_boost: Option<f64>,
    pub rrf_k: Option<f64>,
    pub recency_boost: Option<f64>,
    pub fused_score: Option<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RankingConfig {
    pub short_keyword_weight: f64,
    pub short_semantic_weight: f64,
    pub medium_keyword_weight: f64,
    pub medium_semantic_weight: f64,
    pub long_keyword_weight: f64,
    pub long_semantic_weight: f64,
    pub semantic_relevance_threshold: f64,
    pub recency_boost_max: f64,
    pub rrf_k: f64,
}

impl Default for RankingConfig {
    fn default() -> Self {
        Self {
            short_keyword_weight: 1.35,
            short_semantic_weight: 2.0,
            medium_keyword_weight: 1.15,
            medium_semantic_weight: 2.85,
            long_keyword_weight: 1.0,
            long_semantic_weight: 2.0,
            semantic_relevance_threshold: 0.385,
            recency_boost_max: 0.02,
            rrf_k: 10.0,
        }
    }
}

impl RankingConfig {
    fn normalized(self) -> Self {
        Self {
            short_keyword_weight: sanitize_weight(self.short_keyword_weight, 1.35),
            short_semantic_weight: sanitize_weight(self.short_semantic_weight, 2.0),
            medium_keyword_weight: sanitize_weight(self.medium_keyword_weight, 1.15),
            medium_semantic_weight: sanitize_weight(self.medium_semantic_weight, 2.85),
            long_keyword_weight: sanitize_weight(self.long_keyword_weight, 1.0),
            long_semantic_weight: sanitize_weight(self.long_semantic_weight, 2.0),
            semantic_relevance_threshold: sanitize_threshold(
                self.semantic_relevance_threshold,
                0.385,
            ),
            recency_boost_max: sanitize_non_negative(self.recency_boost_max, 0.02),
            rrf_k: sanitize_non_negative(self.rrf_k, 10.0).max(1.0),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchEntryResult {
    pub entry: EntryRow,
    pub rank: f64,
    pub match_type: String,
    pub match_reasons: Vec<String>,
    pub matched_terms: Vec<String>,
    pub matched_tags: Vec<String>,
    pub diagnostics: SearchDiagnostics,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildSearchIndexesResult {
    pub indexed_entries: i64,
    pub indexed_tags: i64,
}

#[derive(Debug)]
struct SearchIndexEntry {
    id: String,
    content: String,
    label: Option<String>,
    tags_json: Option<String>,
    manual_badges: Option<String>,
    source_app: Option<String>,
    import_name: Option<String>,
}

#[derive(Debug)]
struct SelectedEntries {
    entries: Vec<EntryRow>,
    applied_filters: Vec<String>,
}

#[derive(Debug)]
struct SemanticSearchOutcome {
    results: Vec<SearchEntryResult>,
    candidate_count: usize,
}

#[derive(Debug)]
struct HybridWeights {
    keyword: f64,
    semantic: f64,
}

#[derive(Debug)]
struct HybridCandidate {
    entry: EntryRow,
    fused_score: f64,
    keyword_rank: Option<i64>,
    semantic_rank: Option<i64>,
    keyword_weight: Option<f64>,
    semantic_weight: Option<f64>,
    keyword_rrf_score: f64,
    semantic_rrf_score: f64,
    recency_max_boost: f64,
    rrf_k: f64,
    recency_boost: f64,
    bm25: Option<f64>,
    cosine_similarity: Option<f64>,
    matched_tags: Vec<String>,
    matched_terms: Vec<String>,
    match_reasons: Vec<String>,
}

#[tauri::command]
pub fn search_entries(
    state: TauriState<DbState>,
    query: Option<String>,
    filters: Option<SearchFilters>,
    limit: Option<i64>,
    mode: Option<SearchMode>,
    query_embedding: Option<Vec<f64>>,
    ranking_config: Option<RankingConfig>,
) -> Result<Vec<SearchEntryResult>, String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    search_entries_with_conn(
        conn,
        query,
        filters.unwrap_or_default(),
        limit.unwrap_or(100),
        mode.unwrap_or_default(),
        query_embedding,
        ranking_config.unwrap_or_default().normalized(),
    )
}

#[tauri::command]
pub fn get_related_entries(
    state: TauriState<DbState>,
    entry_id: String,
    filters: Option<SearchFilters>,
    limit: Option<i64>,
    ranking_config: Option<RankingConfig>,
) -> Result<Vec<SearchEntryResult>, String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    get_related_entries_with_conn(
        conn,
        &entry_id,
        filters.unwrap_or_default(),
        limit.unwrap_or(12),
        ranking_config.unwrap_or_default().normalized(),
    )
}

#[tauri::command]
pub fn rebuild_search_indexes(
    state: TauriState<DbState>,
) -> Result<RebuildSearchIndexesResult, String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    rebuild_all_search_indexes(conn)
}

#[tauri::command]
pub fn list_manual_badge_suggestions(state: TauriState<DbState>) -> Result<Vec<String>, String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    list_manual_badge_suggestions_with_conn(conn)
}

#[tauri::command]
pub fn list_badge_suggestions(
    state: TauriState<DbState>,
    query: Option<String>,
    query_embedding: Option<Vec<f64>>,
    ranking_config: Option<RankingConfig>,
) -> Result<Vec<String>, String> {
    let guard = state.conn.lock().map_err(|e| e.to_string())?;
    let conn = guard.as_ref().ok_or("DB not initialised")?;
    list_badge_suggestions_with_conn(
        conn,
        query,
        query_embedding,
        ranking_config.unwrap_or_default().normalized(),
    )
}

pub(crate) fn ensure_search_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS entry_tags (
            entry_id  TEXT NOT NULL,
            tag       TEXT NOT NULL,
            tag_kind  TEXT NOT NULL,
            PRIMARY KEY (entry_id, tag, tag_kind)
        );
        CREATE TABLE IF NOT EXISTS entry_terms (
            entry_id TEXT NOT NULL,
            term     TEXT NOT NULL,
            PRIMARY KEY (entry_id, term)
        );
        CREATE INDEX IF NOT EXISTS idx_entry_tags_tag ON entry_tags(tag);
        CREATE INDEX IF NOT EXISTS idx_entry_tags_entry_id ON entry_tags(entry_id);
        CREATE INDEX IF NOT EXISTS idx_entry_terms_term ON entry_terms(term);
        CREATE INDEX IF NOT EXISTS idx_entry_terms_entry_id ON entry_terms(entry_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
            entry_id UNINDEXED,
            content,
            label,
            tags,
            source_app,
            import_name,
            tokenize = 'unicode61 remove_diacritics 2'
        );
        ",
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

pub(crate) fn rebuild_all_search_indexes(
    conn: &Connection,
) -> Result<RebuildSearchIndexesResult, String> {
    ensure_search_schema(conn)?;
    conn.execute("DELETE FROM entry_tags", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM entry_terms", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM entries_fts", [])
        .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, content, label, tags_json, manual_badges, source_app, import_name
             FROM entries",
        )
        .map_err(|e| e.to_string())?;

    let indexed_entries = stmt
        .query_map([], |row| {
            Ok(SearchIndexEntry {
                id: row.get(0)?,
                content: row.get(1)?,
                label: row.get(2)?,
                tags_json: row.get(3)?,
                manual_badges: row.get(4)?,
                source_app: row.get(5)?,
                import_name: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    for entry in &indexed_entries {
        index_entry(conn, entry)?;
    }

    let indexed_tags = conn
        .query_row("SELECT COUNT(*) FROM entry_tags", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;

    Ok(RebuildSearchIndexesResult {
        indexed_entries: indexed_entries.len() as i64,
        indexed_tags,
    })
}

pub(crate) fn sync_entry_search_data(conn: &Connection, entry_id: &str) -> Result<(), String> {
    ensure_search_schema(conn)?;
    remove_entry_search_data(conn, entry_id)?;

    let entry = conn
        .query_row(
            "SELECT id, content, label, tags_json, manual_badges, source_app, import_name
             FROM entries WHERE id = ?1",
            params![entry_id],
            |row| {
                Ok(SearchIndexEntry {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    label: row.get(2)?,
                    tags_json: row.get(3)?,
                    manual_badges: row.get(4)?,
                    source_app: row.get(5)?,
                    import_name: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some(entry) = entry {
        index_entry(conn, &entry)?;
    }

    Ok(())
}

pub(crate) fn remove_entry_search_data(conn: &Connection, entry_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM entry_tags WHERE entry_id = ?1",
        params![entry_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM entry_terms WHERE entry_id = ?1",
        params![entry_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM entries_fts WHERE entry_id = ?1",
        params![entry_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn list_manual_badge_suggestions_with_conn(
    conn: &Connection,
) -> Result<Vec<String>, String> {
    ensure_search_schema(conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT tag
             FROM entry_tags
             WHERE tag_kind = 'manual'
             ORDER BY tag COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub(crate) fn list_badge_suggestions_with_conn(
    conn: &Connection,
    query: Option<String>,
    query_embedding: Option<Vec<f64>>,
    ranking_config: RankingConfig,
) -> Result<Vec<String>, String> {
    ensure_search_schema(conn)?;

    let all_tags = list_all_badge_suggestions_with_conn(conn)?;
    let query_text = normalize_optional_text(query);
    if query_text.is_none() {
        return Ok(all_tags);
    }

    let normalized_query_embedding = normalize_embedding(query_embedding);

    let mut results = search_entries_with_conn(
        conn,
        query_text,
        SearchFilters::default(),
        100,
        if normalized_query_embedding.is_some() {
            SearchMode::Hybrid
        } else {
            SearchMode::Keyword
        },
        normalized_query_embedding.clone(),
        ranking_config,
    )?;

    if normalized_query_embedding.is_some() {
        results.sort_by(|left, right| {
            match (
                left.diagnostics.semantic_rank,
                right.diagnostics.semantic_rank,
            ) {
                (Some(left_rank), Some(right_rank)) => left_rank
                    .cmp(&right_rank)
                    .then_with(|| {
                        right
                            .rank
                            .partial_cmp(&left.rank)
                            .unwrap_or(Ordering::Equal)
                    })
                    .then_with(|| right.entry.created_at.cmp(&left.entry.created_at)),
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                (None, None) => right
                    .rank
                    .partial_cmp(&left.rank)
                    .unwrap_or(Ordering::Equal)
                    .then_with(|| right.entry.created_at.cmp(&left.entry.created_at)),
            }
        });
    }

    let mut ranked_tags = Vec::new();
    for result in results {
        for tag in collect_entry_tag_names(
            result.entry.tags_json.as_deref(),
            result.entry.label.as_deref(),
            result.entry.manual_badges.as_deref(),
        )? {
            if !ranked_tags.iter().any(|existing| existing == &tag) {
                ranked_tags.push(tag);
            }
        }
    }

    for tag in all_tags {
        if !ranked_tags.iter().any(|existing| existing == &tag) {
            ranked_tags.push(tag);
        }
    }

    Ok(ranked_tags)
}

fn list_all_badge_suggestions_with_conn(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT tag
             FROM entry_tags
             ORDER BY tag COLLATE NOCASE ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub(crate) fn search_entries_with_conn(
    conn: &Connection,
    query: Option<String>,
    filters: SearchFilters,
    limit: i64,
    mode: SearchMode,
    query_embedding: Option<Vec<f64>>,
    ranking_config: RankingConfig,
) -> Result<Vec<SearchEntryResult>, String> {
    ensure_search_schema(conn)?;

    let limit = normalize_limit(limit);
    let query_text = normalize_optional_text(query);
    let query_terms = tokenize_query(query_text.as_deref());

    match mode {
        SearchMode::Semantic if query_text.is_some() => {
            if let Some(query_embedding) = normalize_embedding(query_embedding) {
                let semantic = semantic_search_with_conn(
                    conn,
                    query_text.clone(),
                    query_terms.clone(),
                    filters.clone(),
                    limit,
                    &query_embedding,
                    None,
                    ranking_config,
                )?;

                if !semantic.results.is_empty() {
                    return Ok(semantic.results);
                }

                let fallback_reason = if semantic.candidate_count == 0 {
                    "no_semantic_candidates"
                } else {
                    "no_valid_candidate_embeddings"
                };

                return keyword_search_with_conn(
                    conn,
                    query_text,
                    query_terms,
                    filters,
                    limit,
                    Some(fallback_reason.to_string()),
                );
            }

            keyword_search_with_conn(
                conn,
                query_text,
                query_terms,
                filters,
                limit,
                Some("missing_query_embedding".to_string()),
            )
        }
        SearchMode::Hybrid if query_text.is_some() => {
            if let Some(query_embedding) = normalize_embedding(query_embedding) {
                hybrid_search_with_conn(
                    conn,
                    query_text,
                    query_terms,
                    filters,
                    limit,
                    &query_embedding,
                    ranking_config,
                )
            } else {
                keyword_search_with_conn(
                    conn,
                    query_text,
                    query_terms,
                    filters,
                    limit,
                    Some("missing_query_embedding".to_string()),
                )
            }
        }
        _ => keyword_search_with_conn(conn, query_text, query_terms, filters, limit, None),
    }
}

fn hybrid_search_with_conn(
    conn: &Connection,
    query_text: Option<String>,
    query_terms: Vec<String>,
    filters: SearchFilters,
    limit: i64,
    query_embedding: &[f64],
    ranking_config: RankingConfig,
) -> Result<Vec<SearchEntryResult>, String> {
    let candidate_limit = hybrid_candidate_limit(limit);
    let fts_query = build_fts_query(&query_terms);
    let applied_filters = build_applied_filters_for_hybrid(conn, &filters, &query_text)?;
    let keyword_results = keyword_search_with_conn(
        conn,
        query_text.clone(),
        query_terms.clone(),
        filters.clone(),
        candidate_limit,
        None,
    )?;
    let semantic = semantic_search_with_conn(
        conn,
        query_text.clone(),
        query_terms.clone(),
        filters.clone(),
        candidate_limit,
        query_embedding,
        None,
        ranking_config,
    )?;
    let mut semantic_results = semantic.results;
    let mut cosine_scores = HashMap::<String, f64>::new();
    for result in &semantic_results {
        if let Some(score) = result.diagnostics.cosine_similarity {
            cosine_scores.insert(result.entry.id.clone(), score);
        }
    }

    let mut semantic_seen = semantic_results
        .iter()
        .map(|result| result.entry.id.clone())
        .collect::<HashSet<_>>();
    let semantic_applied_filters = build_applied_filters_for_hybrid(conn, &filters, &query_text)?;

    for keyword_result in &keyword_results {
        let Some(entry_embedding) = parse_entry_embedding(conn, &keyword_result.entry.id) else {
            continue;
        };

        let score = cosine_similarity(query_embedding, entry_embedding.as_slice());
        cosine_scores.insert(keyword_result.entry.id.clone(), score);
        if semantic_seen.contains(&keyword_result.entry.id) {
            continue;
        }

        let matched_tags = collect_matched_tags(
            &keyword_result.entry,
            query_terms.as_slice(),
            filters.tag.as_deref(),
        );

        semantic_results.push(SearchEntryResult {
            entry: keyword_result.entry.clone(),
            rank: score,
            match_type: "semantic".to_string(),
            match_reasons: vec!["semantic".to_string()],
            matched_terms: query_terms.clone(),
            matched_tags,
            diagnostics: SearchDiagnostics {
                query_text: query_text.clone(),
                fts_query: None,
                applied_filters: semantic_applied_filters.clone(),
                bm25: None,
                search_mode: Some(SearchMode::Semantic),
                cosine_similarity: Some(score),
                semantic_fallback_reason: None,
                keyword_rank: None,
                semantic_rank: None,
                keyword_weight: None,
                semantic_weight: None,
                keyword_rrf_score: None,
                semantic_rrf_score: None,
                recency_max_boost: None,
                rrf_k: None,
                recency_boost: None,
                fused_score: None,
            },
        });
        semantic_seen.insert(keyword_result.entry.id.clone());
    }

    semantic_results.sort_by(|left, right| {
        right
            .rank
            .partial_cmp(&left.rank)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| right.entry.created_at.cmp(&left.entry.created_at))
    });

    let weights = hybrid_weights(
        query_text.as_deref(),
        query_terms.as_slice(),
        ranking_config,
    );
    let fallback_reason = if semantic_results.is_empty() {
        Some(
            if semantic.candidate_count == 0 {
                "no_semantic_candidates"
            } else {
                "no_valid_candidate_embeddings"
            }
            .to_string(),
        )
    } else {
        None
    };

    let mut candidates = HashMap::<String, HybridCandidate>::new();

    for (index, result) in keyword_results.iter().enumerate() {
        let entry_id = result.entry.id.clone();
        let candidate = candidates
            .entry(entry_id)
            .or_insert_with(|| HybridCandidate {
                entry: result.entry.clone(),
                fused_score: 0.0,
                keyword_rank: None,
                semantic_rank: None,
                keyword_weight: None,
                semantic_weight: None,
                keyword_rrf_score: 0.0,
                semantic_rrf_score: 0.0,
                recency_max_boost: ranking_config.recency_boost_max,
                rrf_k: ranking_config.rrf_k,
                recency_boost: 0.0,
                bm25: None,
                cosine_similarity: None,
                matched_tags: result.matched_tags.clone(),
                matched_terms: result.matched_terms.clone(),
                match_reasons: Vec::new(),
            });
        let keyword_rrf_score = weighted_rrf_score(weights.keyword, index, ranking_config);
        candidate.fused_score += keyword_rrf_score;
        candidate.keyword_rank = Some((index + 1) as i64);
        candidate.keyword_weight = Some(weights.keyword);
        candidate.keyword_rrf_score = keyword_rrf_score;
        candidate.bm25 = result.diagnostics.bm25;
        candidate.cosine_similarity = cosine_scores.get(&result.entry.id).copied();
        merge_unique_strings(&mut candidate.matched_tags, result.matched_tags.as_slice());
        merge_unique_strings(
            &mut candidate.matched_terms,
            result.matched_terms.as_slice(),
        );
        push_unique_reason(&mut candidate.match_reasons, "keyword");
    }

    for (index, result) in semantic_results.iter().enumerate() {
        let entry_id = result.entry.id.clone();
        let candidate = candidates
            .entry(entry_id)
            .or_insert_with(|| HybridCandidate {
                entry: result.entry.clone(),
                fused_score: 0.0,
                keyword_rank: None,
                semantic_rank: None,
                keyword_weight: None,
                semantic_weight: None,
                keyword_rrf_score: 0.0,
                semantic_rrf_score: 0.0,
                recency_max_boost: ranking_config.recency_boost_max,
                rrf_k: ranking_config.rrf_k,
                recency_boost: 0.0,
                bm25: None,
                cosine_similarity: None,
                matched_tags: result.matched_tags.clone(),
                matched_terms: result.matched_terms.clone(),
                match_reasons: Vec::new(),
            });
        let semantic_rrf_score = weighted_rrf_score(weights.semantic, index, ranking_config);
        candidate.fused_score += semantic_rrf_score;
        candidate.semantic_rank = Some((index + 1) as i64);
        candidate.semantic_weight = Some(weights.semantic);
        candidate.semantic_rrf_score = semantic_rrf_score;
        candidate.cosine_similarity = result.diagnostics.cosine_similarity;
        merge_unique_strings(&mut candidate.matched_tags, result.matched_tags.as_slice());
        merge_unique_strings(
            &mut candidate.matched_terms,
            result.matched_terms.as_slice(),
        );
        push_unique_reason(&mut candidate.match_reasons, "semantic");
    }

    let mut candidates = candidates.into_values().collect::<Vec<_>>();
    apply_recency_boost(candidates.as_mut_slice(), ranking_config);

    candidates.sort_by(|left, right| {
        right
            .fused_score
            .partial_cmp(&left.fused_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| right.entry.created_at.cmp(&left.entry.created_at))
    });

    Ok(candidates
        .into_iter()
        .take(limit as usize)
        .map(|candidate| {
            let match_type = match (
                candidate.keyword_rank.is_some(),
                candidate.semantic_rank.is_some(),
            ) {
                (true, true) => "hybrid",
                (true, false) => "keyword",
                (false, true) => "semantic",
                (false, false) => "filters_only",
            };

            SearchEntryResult {
                entry: candidate.entry,
                rank: candidate.fused_score,
                match_type: match_type.to_string(),
                match_reasons: candidate.match_reasons,
                matched_terms: candidate.matched_terms,
                matched_tags: candidate.matched_tags,
                diagnostics: SearchDiagnostics {
                    query_text: query_text.clone(),
                    fts_query: fts_query.clone(),
                    applied_filters: applied_filters.clone(),
                    bm25: candidate.bm25,
                    search_mode: Some(SearchMode::Hybrid),
                    cosine_similarity: candidate.cosine_similarity,
                    semantic_fallback_reason: fallback_reason.clone(),
                    keyword_rank: candidate.keyword_rank,
                    semantic_rank: candidate.semantic_rank,
                    keyword_weight: candidate.keyword_weight,
                    semantic_weight: candidate.semantic_weight,
                    keyword_rrf_score: if candidate.keyword_rank.is_some() {
                        Some(candidate.keyword_rrf_score)
                    } else {
                        None
                    },
                    semantic_rrf_score: if candidate.semantic_rank.is_some() {
                        Some(candidate.semantic_rrf_score)
                    } else {
                        None
                    },
                    recency_max_boost: Some(candidate.recency_max_boost),
                    rrf_k: Some(candidate.rrf_k),
                    recency_boost: Some(candidate.recency_boost),
                    fused_score: Some(candidate.fused_score),
                },
            }
        })
        .collect())
}

pub(crate) fn get_related_entries_with_conn(
    conn: &Connection,
    entry_id: &str,
    mut filters: SearchFilters,
    limit: i64,
    ranking_config: RankingConfig,
) -> Result<Vec<SearchEntryResult>, String> {
    ensure_search_schema(conn)?;

    let limit = normalize_limit(limit);
    let anchor = conn
        .query_row(
            &format!(
                "SELECT {} FROM entries e WHERE e.id = ?1",
                entry_select_columns_with_prefix("e")
            ),
            params![entry_id],
            row_to_entry,
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Entry not found: {}", entry_id))?;

    if filters.collection_id.is_none() && filters.is_note.is_none() && filters.scope.is_none() {
        if let Some(collection_id) = anchor.collection_id.clone() {
            filters.collection_id = Some(collection_id);
        } else {
            filters.is_note = Some(anchor.is_note);
        }
    }

    if let Some(anchor_embedding) = parse_entry_embedding(conn, &anchor.id) {
        let semantic = semantic_search_with_conn(
            conn,
            None,
            Vec::new(),
            filters.clone(),
            limit,
            anchor_embedding.as_slice(),
            Some(entry_id),
            ranking_config,
        )?;

        if !semantic.results.is_empty() {
            return Ok(semantic
                .results
                .into_iter()
                .map(|mut result| {
                    result.match_type = "related_semantic".to_string();
                    result
                })
                .collect());
        }
    }

    fallback_related_entries_with_conn(conn, &anchor, filters, limit)
}

fn keyword_search_with_conn(
    conn: &Connection,
    query_text: Option<String>,
    query_terms: Vec<String>,
    filters: SearchFilters,
    limit: i64,
    semantic_fallback_reason: Option<String>,
) -> Result<Vec<SearchEntryResult>, String> {
    if query_terms.is_empty() {
        return keyword_filters_only_with_conn(
            conn,
            query_text,
            filters,
            limit,
            semantic_fallback_reason,
        );
    }

    let fts_query = build_fts_query(&query_terms);
    let applied_filters = build_applied_filters_for_hybrid(conn, &filters, &query_text)?;
    let exact_results = exact_keyword_search_with_conn(
        conn,
        query_text.clone(),
        query_terms.clone(),
        filters.clone(),
        limit,
        semantic_fallback_reason.clone(),
    )?;

    let mut seen_ids = exact_results
        .iter()
        .map(|result| result.entry.id.clone())
        .collect::<HashSet<_>>();
    let mut results = exact_results;

    let prefix_limit = limit.saturating_mul(PREFIX_SEARCH_EXPANSION);
    for candidate in
        prefix_keyword_candidates_with_conn(conn, &query_terms, &filters, prefix_limit)?
    {
        if results.len() >= limit as usize {
            break;
        }
        if !seen_ids.insert(candidate.entry.id.clone()) {
            continue;
        }

        let matched_tags = collect_matched_tags(
            &candidate.entry,
            query_terms.as_slice(),
            filters.tag.as_deref(),
        );
        results.push(SearchEntryResult {
            entry: candidate.entry,
            rank: prefix_rank(candidate.quality_penalty),
            match_type: "keyword".to_string(),
            match_reasons: vec!["keyword".to_string(), "prefix".to_string()],
            matched_terms: candidate.matched_terms,
            matched_tags,
            diagnostics: SearchDiagnostics {
                query_text: query_text.clone(),
                fts_query: fts_query.clone(),
                applied_filters: applied_filters.clone(),
                bm25: None,
                search_mode: Some(SearchMode::Keyword),
                cosine_similarity: None,
                semantic_fallback_reason: semantic_fallback_reason.clone(),
                keyword_rank: None,
                semantic_rank: None,
                keyword_weight: None,
                semantic_weight: None,
                keyword_rrf_score: None,
                semantic_rrf_score: None,
                recency_max_boost: None,
                rrf_k: None,
                recency_boost: None,
                fused_score: None,
            },
        });
    }

    if results.len() < limit as usize {
        let fuzzy_limit = limit.saturating_mul(FUZZY_SEARCH_EXPANSION);
        for candidate in
            fuzzy_keyword_candidates_with_conn(conn, &query_terms, &filters, fuzzy_limit)?
        {
            if results.len() >= limit as usize {
                break;
            }
            if !seen_ids.insert(candidate.entry.id.clone()) {
                continue;
            }

            let matched_tags = collect_matched_tags(
                &candidate.entry,
                query_terms.as_slice(),
                filters.tag.as_deref(),
            );
            let matched_terms = candidate
                .matches
                .iter()
                .map(|term| format!("{}:{}", term.query_term, term.matched_term))
                .collect();
            results.push(SearchEntryResult {
                entry: candidate.entry,
                rank: candidate.similarity,
                match_type: "keyword".to_string(),
                match_reasons: vec!["keyword".to_string(), "fuzzy".to_string()],
                matched_terms,
                matched_tags,
                diagnostics: SearchDiagnostics {
                    query_text: query_text.clone(),
                    fts_query: fts_query.clone(),
                    applied_filters: applied_filters.clone(),
                    bm25: None,
                    search_mode: Some(SearchMode::Keyword),
                    cosine_similarity: None,
                    semantic_fallback_reason: semantic_fallback_reason.clone(),
                    keyword_rank: None,
                    semantic_rank: None,
                    keyword_weight: None,
                    semantic_weight: None,
                    keyword_rrf_score: None,
                    semantic_rrf_score: None,
                    recency_max_boost: None,
                    rrf_k: None,
                    recency_boost: None,
                    fused_score: None,
                },
            });
        }
    }

    Ok(results)
}

fn keyword_filters_only_with_conn(
    conn: &Connection,
    query_text: Option<String>,
    filters: SearchFilters,
    limit: i64,
    semantic_fallback_reason: Option<String>,
) -> Result<Vec<SearchEntryResult>, String> {
    let mut applied_filters = Vec::new();
    let mut param_values = Vec::<Value>::new();
    let conditions =
        build_filter_conditions(&filters, "e", conn, &mut param_values, &mut applied_filters)?;
    let where_clause = build_where_clause(&conditions);
    param_values.push(Value::Integer(limit));

    let sql = format!(
        "SELECT {}, 0.0 AS search_rank, NULL AS bm25_score FROM entries e{} ORDER BY e.created_at DESC LIMIT ?",
        entry_select_columns_with_prefix("e"),
        where_clause
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(params_from_iter(param_values.iter()))
        .map_err(|e| e.to_string())?;
    let mut results = Vec::new();

    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let entry = row_to_entry(row).map_err(|e| e.to_string())?;
        results.push(SearchEntryResult {
            entry,
            rank: 0.0,
            match_type: "filters_only".to_string(),
            match_reasons: Vec::new(),
            matched_terms: Vec::new(),
            matched_tags: Vec::new(),
            diagnostics: SearchDiagnostics {
                query_text: query_text.clone(),
                fts_query: None,
                applied_filters: applied_filters.clone(),
                bm25: None,
                search_mode: Some(SearchMode::Keyword),
                cosine_similarity: None,
                semantic_fallback_reason: semantic_fallback_reason.clone(),
                keyword_rank: None,
                semantic_rank: None,
                keyword_weight: None,
                semantic_weight: None,
                keyword_rrf_score: None,
                semantic_rrf_score: None,
                recency_max_boost: None,
                rrf_k: None,
                recency_boost: None,
                fused_score: None,
            },
        });
    }

    Ok(results)
}

fn exact_keyword_search_with_conn(
    conn: &Connection,
    query_text: Option<String>,
    query_terms: Vec<String>,
    filters: SearchFilters,
    limit: i64,
    semantic_fallback_reason: Option<String>,
) -> Result<Vec<SearchEntryResult>, String> {
    let fts_query = build_fts_query(&query_terms);
    let Some(fts_query) = fts_query else {
        return Ok(Vec::new());
    };

    let mut conditions = vec!["entries_fts MATCH ?".to_string()];
    let mut applied_filters = vec![format!("query:{}", query_text.clone().unwrap_or_default())];
    let mut param_values = vec![Value::Text(fts_query.clone())];

    conditions.extend(build_filter_conditions(
        &filters,
        "e",
        conn,
        &mut param_values,
        &mut applied_filters,
    )?);

    let sql = format!(
        "SELECT {}, COALESCE(-bm25(entries_fts), 0.0) AS search_rank, bm25(entries_fts) AS bm25_score \
         FROM entries e JOIN entries_fts ON entries_fts.entry_id = e.id{} \
         ORDER BY bm25_score ASC, e.created_at DESC LIMIT ?",
        entry_select_columns_with_prefix("e"),
        build_where_clause(&conditions)
    );

    param_values.push(Value::Integer(limit));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(params_from_iter(param_values.iter()))
        .map_err(|e| e.to_string())?;
    let mut results = Vec::new();

    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let entry = row_to_entry(row).map_err(|e| e.to_string())?;
        let rank = row.get::<_, f64>(22).map_err(|e| e.to_string())?;
        let bm25 = row.get::<_, Option<f64>>(23).map_err(|e| e.to_string())?;
        let matched_tags =
            collect_matched_tags(&entry, query_terms.as_slice(), filters.tag.as_deref());

        results.push(SearchEntryResult {
            entry,
            rank,
            match_type: "keyword".to_string(),
            match_reasons: vec!["keyword".to_string(), "exact".to_string()],
            matched_terms: query_terms.clone(),
            matched_tags,
            diagnostics: SearchDiagnostics {
                query_text: query_text.clone(),
                fts_query: Some(fts_query.clone()),
                applied_filters: applied_filters.clone(),
                bm25,
                search_mode: Some(SearchMode::Keyword),
                cosine_similarity: None,
                semantic_fallback_reason: semantic_fallback_reason.clone(),
                keyword_rank: None,
                semantic_rank: None,
                keyword_weight: None,
                semantic_weight: None,
                keyword_rrf_score: None,
                semantic_rrf_score: None,
                recency_max_boost: None,
                rrf_k: None,
                recency_boost: None,
                fused_score: None,
            },
        });
    }

    Ok(results)
}

fn prefix_keyword_candidates_with_conn(
    conn: &Connection,
    query_terms: &[String],
    filters: &SearchFilters,
    limit: i64,
) -> Result<Vec<PrefixMatchCandidate>, String> {
    if query_terms.is_empty() {
        return Ok(Vec::new());
    }

    let mut joins = Vec::new();
    let mut select_parts = Vec::new();
    let mut select_params = Vec::<Value>::new();
    let mut join_params = Vec::<Value>::new();

    for (index, term) in query_terms.iter().enumerate() {
        let alias = format!("et{}", index);
        joins.push(format!(
            "JOIN entry_terms {alias} ON {alias}.entry_id = e.id AND {alias}.term LIKE ? ESCAPE '\\'"
        ));
        select_parts.push(format!("(LENGTH({alias}.term) - ?)"));
        select_params.push(Value::Integer(term.chars().count() as i64));
        join_params.push(Value::Text(format!("{}%", escape_like_pattern(term))));
    }

    let mut conditions = Vec::new();
    let mut applied_filters = Vec::new();
    let mut param_values = select_params;
    param_values.extend(join_params);
    conditions.extend(build_filter_conditions(
        filters,
        "e",
        conn,
        &mut param_values,
        &mut applied_filters,
    )?);

    let sql = format!(
        "SELECT {}, MIN({}) AS prefix_penalty FROM entries e {}{} \
         GROUP BY e.id ORDER BY prefix_penalty ASC, e.created_at DESC LIMIT ?",
        entry_select_columns_with_prefix("e"),
        select_parts.join(" + "),
        joins.join(" "),
        build_where_clause(&conditions)
    );

    param_values.push(Value::Integer(limit));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(params_from_iter(param_values.iter()))
        .map_err(|e| e.to_string())?;
    let mut candidates = Vec::new();

    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        candidates.push(PrefixMatchCandidate {
            entry: row_to_entry(row).map_err(|e| e.to_string())?,
            matched_terms: query_terms.to_vec(),
            quality_penalty: row.get::<_, i64>(22).map_err(|e| e.to_string())?,
        });
    }

    Ok(candidates)
}

fn fuzzy_keyword_candidates_with_conn(
    conn: &Connection,
    query_terms: &[String],
    filters: &SearchFilters,
    limit: i64,
) -> Result<Vec<FuzzyMatchCandidate>, String> {
    if query_terms.is_empty() {
        return Ok(Vec::new());
    }

    let entries = load_filtered_entries_with_conn(conn, filters, limit.saturating_mul(8))?;
    if entries.is_empty() {
        return Ok(Vec::new());
    }

    let entry_ids = entries
        .iter()
        .map(|entry| entry.id.clone())
        .collect::<Vec<_>>();
    let terms_by_entry = load_terms_for_entries(conn, &entry_ids)?;
    let mut candidates = Vec::new();

    for entry in entries {
        let Some(entry_terms) = terms_by_entry.get(&entry.id) else {
            continue;
        };

        let mut matches = Vec::new();
        let mut total_distance = 0usize;
        let mut total_similarity = 0.0;
        let mut matched_all = true;

        for query_term in query_terms {
            let Some(best) = best_fuzzy_term_match(query_term, entry_terms.as_slice()) else {
                matched_all = false;
                break;
            };

            total_distance += best.distance;
            total_similarity += fuzzy_similarity(query_term, &best.matched_term, best.distance);
            matches.push(best);
        }

        if !matched_all {
            continue;
        }

        candidates.push(FuzzyMatchCandidate {
            entry,
            matches,
            total_distance,
            similarity: total_similarity / query_terms.len() as f64,
        });
    }

    candidates.sort_by(|left, right| {
        left.total_distance
            .cmp(&right.total_distance)
            .then_with(|| {
                right
                    .similarity
                    .partial_cmp(&left.similarity)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| right.entry.created_at.cmp(&left.entry.created_at))
    });
    candidates.truncate(limit as usize);
    Ok(candidates)
}

fn semantic_search_with_conn(
    conn: &Connection,
    query_text: Option<String>,
    query_terms: Vec<String>,
    filters: SearchFilters,
    limit: i64,
    query_embedding: &[f64],
    exclude_entry_id: Option<&str>,
    ranking_config: RankingConfig,
) -> Result<SemanticSearchOutcome, String> {
    let query_f32: Vec<f32> = query_embedding.iter().map(|&v| v as f32).collect();
    if query_f32.is_empty() {
        return Ok(SemanticSearchOutcome {
            results: Vec::new(),
            candidate_count: 0,
        });
    }
    if query_f32.len() != 384 {
        eprintln!(
            "semantic_search: query embedding has {} dimensions, expected 384",
            query_f32.len()
        );
    }
    let query_bytes: Vec<u8> = query_f32.iter().flat_map(|f| f.to_le_bytes()).collect();

    // Get more candidates than needed from vec search, then post-filter
    let vec_k = (limit * 10).clamp(50, 500) as i64;

    // Step 1: Get nearest neighbors from sqlite-vec
    let mut vec_stmt = conn.prepare(
        "SELECT entry_id, distance FROM vec_entries WHERE embedding MATCH ?1 ORDER BY distance LIMIT ?2"
    ).map_err(|e| e.to_string())?;

    let candidates: Vec<(String, f64)> = vec_stmt
        .query_map(params![query_bytes, vec_k], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let candidate_count = candidates.len();
    if candidates.is_empty() {
        eprintln!("semantic_search: vec_entries returned 0 candidates");
        return Ok(SemanticSearchOutcome {
            results: Vec::new(),
            candidate_count: 0,
        });
    }

    // Step 2: Fetch full entries for candidates and apply filters
    let placeholders = candidates.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let mut param_values = Vec::<Value>::new();
    let mut applied_filters = Vec::new();

    for (id, _) in &candidates {
        param_values.push(Value::Text(id.clone()));
    }

    let mut conditions = vec![format!("e.id IN ({})", placeholders)];

    conditions.extend(build_filter_conditions(
        &filters,
        "e",
        conn,
        &mut param_values,
        &mut applied_filters,
    )?);

    if let Some(entry_id) = exclude_entry_id {
        conditions.push("e.id <> ?".to_string());
        param_values.push(Value::Text(entry_id.to_string()));
        applied_filters.push(format!("exclude:{}", entry_id));
    }

    let sql = format!(
        "SELECT {} FROM entries e WHERE {}",
        entry_select_columns_with_prefix("e"),
        conditions.join(" AND ")
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let entries: Vec<EntryRow> = stmt
        .query_map(params_from_iter(param_values.iter()), row_to_entry)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // Build a distance lookup map
    let distance_map: HashMap<String, f64> = candidates.into_iter().collect();

    // Step 3: Score and sort
    let mut scored: Vec<SearchEntryResult> = entries
        .into_iter()
        .filter_map(|entry| {
            let distance = distance_map.get(&entry.id)?;
            let score = 1.0 - distance;
            if score < ranking_config.semantic_relevance_threshold {
                return None;
            }
            let matched_tags =
                collect_matched_tags(&entry, query_terms.as_slice(), filters.tag.as_deref());
            Some(SearchEntryResult {
                entry,
                rank: score,
                match_type: "semantic".to_string(),
                match_reasons: vec!["semantic".to_string()],
                matched_terms: query_terms.clone(),
                matched_tags,
                diagnostics: SearchDiagnostics {
                    query_text: query_text.clone(),
                    fts_query: None,
                    applied_filters: applied_filters.clone(),
                    bm25: None,
                    search_mode: Some(SearchMode::Semantic),
                    cosine_similarity: Some(score),
                    semantic_fallback_reason: None,
                    keyword_rank: None,
                    semantic_rank: None,
                    keyword_weight: None,
                    semantic_weight: None,
                    keyword_rrf_score: None,
                    semantic_rrf_score: None,
                    recency_max_boost: None,
                    rrf_k: None,
                    recency_boost: None,
                    fused_score: None,
                },
            })
        })
        .collect();

    scored.sort_by(|a, b| {
        b.rank
            .partial_cmp(&a.rank)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.entry.created_at.cmp(&a.entry.created_at))
    });
    scored.truncate(limit as usize);

    Ok(SemanticSearchOutcome {
        results: scored,
        candidate_count,
    })
}

fn fallback_related_entries_with_conn(
    conn: &Connection,
    anchor: &EntryRow,
    filters: SearchFilters,
    limit: i64,
) -> Result<Vec<SearchEntryResult>, String> {
    let SelectedEntries {
        entries,
        applied_filters,
    } = select_entries_by_filters(conn, &filters, Some(anchor.id.as_str()))?;
    let anchor_tags = collect_entry_tag_names(
        anchor.tags_json.as_deref(),
        anchor.label.as_deref(),
        anchor.manual_badges.as_deref(),
    )?;
    let anchor_label = normalize_tag(anchor.label.as_deref());

    let mut scored = entries
        .into_iter()
        .map(|entry| {
            let entry_tags = collect_entry_tag_names(
                entry.tags_json.as_deref(),
                entry.label.as_deref(),
                entry.manual_badges.as_deref(),
            )
            .unwrap_or_default();
            let matched_tags = entry_tags
                .iter()
                .filter(|tag| anchor_tags.contains(*tag))
                .cloned()
                .collect::<Vec<_>>();

            let overlap_score = matched_tags.len() as f64;
            let same_label_bonus = match (&anchor_label, normalize_tag(entry.label.as_deref())) {
                (Some(anchor_label), Some(entry_label)) if anchor_label == &entry_label => 0.5,
                _ => 0.0,
            };
            let same_app_bonus =
                if anchor.source_app.is_some() && anchor.source_app == entry.source_app {
                    0.25
                } else {
                    0.0
                };

            let rank = overlap_score + same_label_bonus + same_app_bonus;
            SearchEntryResult {
                entry,
                rank,
                match_type: "related_fallback".to_string(),
                match_reasons: if matched_tags.is_empty() {
                    Vec::new()
                } else {
                    vec!["related-via-tag".to_string()]
                },
                matched_terms: Vec::new(),
                matched_tags,
                diagnostics: SearchDiagnostics {
                    query_text: None,
                    fts_query: None,
                    applied_filters: applied_filters.clone(),
                    bm25: None,
                    search_mode: Some(SearchMode::Keyword),
                    cosine_similarity: None,
                    semantic_fallback_reason: Some("anchor_embedding_unavailable".to_string()),
                    keyword_rank: None,
                    semantic_rank: None,
                    keyword_weight: None,
                    semantic_weight: None,
                    keyword_rrf_score: None,
                    semantic_rrf_score: None,
                    recency_max_boost: None,
                    rrf_k: None,
                    recency_boost: None,
                    fused_score: None,
                },
            }
        })
        .collect::<Vec<_>>();

    scored.sort_by(|left, right| {
        right
            .rank
            .partial_cmp(&left.rank)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| right.entry.created_at.cmp(&left.entry.created_at))
    });

    Ok(scored.into_iter().take(limit as usize).collect())
}

fn select_entries_by_filters(
    conn: &Connection,
    filters: &SearchFilters,
    exclude_entry_id: Option<&str>,
) -> Result<SelectedEntries, String> {
    let mut param_values = Vec::<Value>::new();
    let mut applied_filters = Vec::new();
    let mut conditions =
        build_filter_conditions(filters, "e", conn, &mut param_values, &mut applied_filters)?;

    if let Some(entry_id) = exclude_entry_id {
        conditions.push("e.id <> ?".to_string());
        param_values.push(Value::Text(entry_id.to_string()));
        applied_filters.push(format!("exclude:{}", entry_id));
    }

    let sql = format!(
        "SELECT {} FROM entries e{} ORDER BY e.created_at DESC",
        entry_select_columns_with_prefix("e"),
        build_where_clause(&conditions)
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let entries = stmt
        .query_map(params_from_iter(param_values.iter()), row_to_entry)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(SelectedEntries {
        entries,
        applied_filters,
    })
}

fn build_filter_conditions(
    filters: &SearchFilters,
    alias: &str,
    conn: &Connection,
    param_values: &mut Vec<Value>,
    applied_filters: &mut Vec<String>,
) -> Result<Vec<String>, String> {
    let mut conditions = Vec::new();

    if let Some(collection_id) = normalize_optional_str(filters.collection_id.as_deref()) {
        conditions.push(format!("{}.collection_id = ?", alias));
        param_values.push(Value::Text(collection_id.to_string()));
        applied_filters.push(format!("collection_id:{}", collection_id));
    } else if let Some(is_note) = filters.is_note {
        conditions.push(format!("{}.is_note = ?", alias));
        param_values.push(Value::Integer(if is_note { 1 } else { 0 }));
        applied_filters.push(format!("is_note:{}", is_note));
    } else if let Some(scope) = filters.scope.as_deref() {
        match scope.trim().to_lowercase().as_str() {
            "note" | "notes" => {
                conditions.push(format!("{}.collection_id = ?", alias));
                param_values.push(Value::Text("notes".to_string()));
                applied_filters.push("scope:notes".to_string());
            }
            "clipboard" | "all" | "library" => {
                applied_filters.push(format!("scope:{}", scope.trim().to_lowercase()));
            }
            other => return Err(format!("Unsupported search scope: {}", other)),
        }
    }

    if let Some(source) = filters.source.as_deref() {
        let normalized = db::normalize_entry_source(source)?;
        conditions.push(format!("{}.source = ?", alias));
        param_values.push(Value::Text(normalized.clone()));
        applied_filters.push(format!("source:{}", normalized));
    }

    if let Some(source_app) = normalize_optional_str(filters.source_app.as_deref()) {
        conditions.push(format!("LOWER(COALESCE({}.source_app, '')) = ?", alias));
        param_values.push(Value::Text(source_app.to_lowercase()));
        applied_filters.push(format!("source_app:{}", source_app));
    }

    if let Some(date_from) = filters.date_from {
        conditions.push(format!("{}.created_at >= ?", alias));
        param_values.push(Value::Integer(date_from));
        applied_filters.push(format!("date_from:{}", date_from));
    }

    if let Some(date_to) = filters.date_to {
        conditions.push(format!("{}.created_at <= ?", alias));
        param_values.push(Value::Integer(date_to));
        applied_filters.push(format!("date_to:{}", date_to));
    }

    if let Some(tag) = normalize_tag(filters.tag.as_deref()) {
        conditions.push(format!(
            "EXISTS (SELECT 1 FROM entry_tags entry_tag_filter WHERE entry_tag_filter.entry_id = {}.id AND entry_tag_filter.tag = ?)",
            alias
        ));
        param_values.push(Value::Text(tag.clone()));
        applied_filters.push(format!("tag:{}", tag));
    }

    if let Some(related_to) = normalize_optional_str(filters.related_to.as_deref()) {
        let related_ids = resolve_related_filter_entry_ids(conn, &related_to)?;
        if related_ids.is_empty() {
            conditions.push("1 = 0".to_string());
        } else {
            let placeholders = related_ids
                .iter()
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(",");
            conditions.push(format!("{}.id IN ({})", alias, placeholders));
            for id in related_ids {
                param_values.push(Value::Text(id));
            }
        }
        applied_filters.push(format!("related_to:{}", related_to));
    }

    Ok(conditions)
}

fn build_where_clause(conditions: &[String]) -> String {
    if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    }
}

fn resolve_related_filter_entry_ids(
    conn: &Connection,
    entry_id: &str,
) -> Result<Vec<String>, String> {
    let mut filters = SearchFilters::default();
    filters.related_to = None;
    let related = get_related_entries_with_conn(
        conn,
        entry_id,
        filters,
        48,
        RankingConfig::default().normalized(),
    )?;

    let mut ids = related
        .into_iter()
        .map(|result| result.entry.id)
        .collect::<Vec<_>>();
    ids.push(entry_id.to_string());
    ids.sort();
    ids.dedup();
    Ok(ids)
}

fn build_applied_filters_for_hybrid(
    conn: &Connection,
    filters: &SearchFilters,
    query_text: &Option<String>,
) -> Result<Vec<String>, String> {
    let mut param_values = Vec::<Value>::new();
    let mut applied_filters = Vec::new();
    if let Some(query) = query_text {
        applied_filters.push(format!("query:{}", query));
    }
    let _ = build_filter_conditions(filters, "e", conn, &mut param_values, &mut applied_filters)?;
    Ok(applied_filters)
}

fn index_entry(conn: &Connection, entry: &SearchIndexEntry) -> Result<(), String> {
    let tags = collect_entry_tags(
        entry.tags_json.as_deref(),
        entry.label.as_deref(),
        entry.manual_badges.as_deref(),
    )?;
    let entry_terms = collect_index_terms(entry, tags.iter().map(|(tag, _)| tag.as_str()))?;

    for (tag, tag_kind) in &tags {
        conn.execute(
            "INSERT INTO entry_tags (entry_id, tag, tag_kind) VALUES (?1, ?2, ?3)",
            params![entry.id, tag, tag_kind],
        )
        .map_err(|e| e.to_string())?;
    }

    let indexed_tags = tags
        .iter()
        .map(|(tag, _)| tag.as_str())
        .collect::<Vec<_>>()
        .join(" ");

    for term in entry_terms {
        conn.execute(
            "INSERT INTO entry_terms (entry_id, term) VALUES (?1, ?2)",
            params![entry.id, term],
        )
        .map_err(|e| e.to_string())?;
    }

    conn.execute(
        "INSERT INTO entries_fts (entry_id, content, label, tags, source_app, import_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            entry.id,
            entry.content,
            entry.label,
            indexed_tags,
            entry.source_app,
            entry.import_name,
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

fn collect_entry_tags(
    tags_json: Option<&str>,
    auto_label: Option<&str>,
    manual_badges: Option<&str>,
) -> Result<Vec<(String, String)>, String> {
    let mut tags = Vec::new();

    for tag in parse_unified_tag_names(tags_json)? {
        if !tags.iter().any(|(existing, _)| existing == &tag) {
            tags.push((tag, "tag".to_string()));
        }
    }

    if !tags.is_empty() {
        return Ok(tags);
    }

    if let Some(label) = normalize_tag(auto_label) {
        tags.push((label, "auto".to_string()));
    }

    for badge in parse_manual_badge_names(manual_badges)? {
        if !tags.iter().any(|(existing, _)| existing == &badge) {
            tags.push((badge, "manual".to_string()));
        }
    }

    Ok(tags)
}

fn collect_entry_tag_names(
    tags_json: Option<&str>,
    auto_label: Option<&str>,
    manual_badges: Option<&str>,
) -> Result<Vec<String>, String> {
    Ok(collect_entry_tags(tags_json, auto_label, manual_badges)?
        .into_iter()
        .map(|(tag, _)| tag)
        .collect())
}

fn parse_unified_tag_names(tags_json: Option<&str>) -> Result<Vec<String>, String> {
    let Some(raw) = tags_json else {
        return Ok(Vec::new());
    };
    let parsed = serde_json::from_str::<serde_json::Value>(raw).map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    if let Some(items) = parsed.as_array() {
        for item in items {
            if let Some(tag) = normalize_tag(item.get("name").and_then(|value| value.as_str())) {
                names.push(tag);
            }
        }
    }
    Ok(names)
}

fn collect_index_terms<'a>(
    entry: &SearchIndexEntry,
    tags: impl IntoIterator<Item = &'a str>,
) -> Result<Vec<String>, String> {
    let mut terms = HashSet::new();

    for term in tokenize_index_text(&entry.content) {
        terms.insert(term);
    }

    if let Some(label) = entry.label.as_deref() {
        for term in tokenize_index_text(label) {
            terms.insert(term);
        }
    }

    for tag in tags {
        for term in tokenize_index_text(tag) {
            terms.insert(term);
        }
    }

    if let Some(source_app) = entry.source_app.as_deref() {
        for term in tokenize_index_text(source_app) {
            terms.insert(term);
        }
    }

    if let Some(import_name) = entry.import_name.as_deref() {
        for term in tokenize_index_text(import_name) {
            terms.insert(term);
        }
    }

    let mut terms = terms.into_iter().collect::<Vec<_>>();
    terms.sort();
    Ok(terms)
}

fn tokenize_index_text(text: &str) -> Vec<String> {
    text.split(|ch: char| !ch.is_alphanumeric())
        .filter_map(|term| {
            let cleaned = term.trim().to_lowercase();
            if cleaned.is_empty() {
                None
            } else {
                Some(cleaned)
            }
        })
        .collect()
}

fn parse_manual_badge_names(manual_badges: Option<&str>) -> Result<Vec<String>, String> {
    let Some(raw) = manual_badges else {
        return Ok(Vec::new());
    };

    let parsed = serde_json::from_str::<serde_json::Value>(raw).map_err(|e| e.to_string())?;
    let mut names = Vec::new();

    if let Some(items) = parsed.as_array() {
        for item in items {
            let candidate = if let Some(name) = item.as_str() {
                Some(name)
            } else {
                item.get("name").and_then(|value| value.as_str())
            };

            if let Some(tag) = normalize_tag(candidate) {
                names.push(tag);
            }
        }
    }

    Ok(names)
}

fn collect_matched_tags(
    entry: &EntryRow,
    query_terms: &[String],
    filter_tag: Option<&str>,
) -> Vec<String> {
    let mut matched = Vec::new();

    if let Some(tag) = normalize_tag(filter_tag) {
        matched.push(tag);
    }

    if let Ok(entry_tags) = collect_entry_tags(
        entry.tags_json.as_deref(),
        entry.label.as_deref(),
        entry.manual_badges.as_deref(),
    ) {
        for (tag, _) in entry_tags {
            if query_terms.iter().any(|term| term == &tag)
                && !matched.iter().any(|existing| existing == &tag)
            {
                matched.push(tag);
            }
        }
    }

    matched
}

fn hybrid_candidate_limit(limit: i64) -> i64 {
    (limit.saturating_mul(4)).clamp(25, 200)
}

fn hybrid_weights(
    query_text: Option<&str>,
    query_terms: &[String],
    ranking_config: RankingConfig,
) -> HybridWeights {
    let query_len = query_text.map(|value| value.len()).unwrap_or_default();
    if query_terms.len() <= 2 || query_len <= 18 {
        HybridWeights {
            keyword: ranking_config.short_keyword_weight,
            semantic: ranking_config.short_semantic_weight,
        }
    } else if query_terms.len() >= 4 || query_len >= 36 {
        HybridWeights {
            keyword: ranking_config.long_keyword_weight,
            semantic: ranking_config.long_semantic_weight,
        }
    } else {
        HybridWeights {
            keyword: ranking_config.medium_keyword_weight,
            semantic: ranking_config.medium_semantic_weight,
        }
    }
}

fn weighted_rrf_score(weight: f64, rank_index: usize, ranking_config: RankingConfig) -> f64 {
    weight / (ranking_config.rrf_k + rank_index as f64 + 1.0)
}

fn apply_recency_boost(candidates: &mut [HybridCandidate], ranking_config: RankingConfig) {
    if candidates.is_empty() {
        return;
    }

    let newest = candidates
        .iter()
        .map(|candidate| candidate.entry.created_at)
        .max()
        .unwrap_or_default();
    let oldest = candidates
        .iter()
        .map(|candidate| candidate.entry.created_at)
        .min()
        .unwrap_or_default();
    let span = (newest - oldest).max(1) as f64;

    for candidate in candidates.iter_mut() {
        let normalized = (candidate.entry.created_at - oldest) as f64 / span;
        candidate.recency_boost = normalized * ranking_config.recency_boost_max;
        candidate.fused_score += candidate.recency_boost;
        if ranking_config.recency_boost_max > 0.0
            && candidate.recency_boost >= ranking_config.recency_boost_max * 0.8
        {
            push_unique_reason(&mut candidate.match_reasons, "recent");
        }
    }
}

fn sanitize_weight(value: f64, fallback: f64) -> f64 {
    if value.is_finite() && value >= 0.0 {
        value
    } else {
        fallback
    }
}

fn sanitize_non_negative(value: f64, fallback: f64) -> f64 {
    if value.is_finite() && value >= 0.0 {
        value
    } else {
        fallback
    }
}

fn sanitize_threshold(value: f64, fallback: f64) -> f64 {
    if value.is_finite() && (0.0..=1.0).contains(&value) {
        value
    } else {
        fallback
    }
}

fn merge_unique_strings(target: &mut Vec<String>, values: &[String]) {
    for value in values {
        if !target.iter().any(|existing| existing == value) {
            target.push(value.clone());
        }
    }
}

fn push_unique_reason(target: &mut Vec<String>, reason: &str) {
    if !target.iter().any(|existing| existing == reason) {
        target.push(reason.to_string());
    }
}

fn escape_like_pattern(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '%' | '_' | '\\' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            _ => escaped.push(ch),
        }
    }
    escaped
}

fn prefix_rank(quality_penalty: i64) -> f64 {
    1.0 / (1.0 + quality_penalty.max(0) as f64)
}

fn fuzzy_similarity(query_term: &str, matched_term: &str, distance: usize) -> f64 {
    let baseline = query_term
        .chars()
        .count()
        .max(matched_term.chars().count())
        .max(1) as f64;
    1.0 - (distance as f64 / baseline)
}

fn load_filtered_entries_with_conn(
    conn: &Connection,
    filters: &SearchFilters,
    limit: i64,
) -> Result<Vec<EntryRow>, String> {
    let mut param_values = Vec::<Value>::new();
    let mut applied_filters = Vec::new();
    let conditions =
        build_filter_conditions(filters, "e", conn, &mut param_values, &mut applied_filters)?;
    let sql = format!(
        "SELECT {} FROM entries e{} ORDER BY e.created_at DESC LIMIT ?",
        entry_select_columns_with_prefix("e"),
        build_where_clause(&conditions)
    );
    param_values.push(Value::Integer(limit));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(param_values.iter()), row_to_entry)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

fn load_terms_for_entries(
    conn: &Connection,
    entry_ids: &[String],
) -> Result<HashMap<String, Vec<String>>, String> {
    if entry_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let placeholders = entry_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT entry_id, term FROM entry_terms WHERE entry_id IN ({}) ORDER BY entry_id, term",
        placeholders
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params = entry_ids
        .iter()
        .map(|entry_id| Value::Text(entry_id.clone()))
        .collect::<Vec<_>>();
    let mut rows = stmt
        .query(params_from_iter(params.iter()))
        .map_err(|e| e.to_string())?;
    let mut terms = HashMap::<String, Vec<String>>::new();

    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let entry_id = row.get::<_, String>(0).map_err(|e| e.to_string())?;
        let term = row.get::<_, String>(1).map_err(|e| e.to_string())?;
        terms.entry(entry_id).or_default().push(term);
    }

    Ok(terms)
}

fn best_fuzzy_term_match(query_term: &str, entry_terms: &[String]) -> Option<FuzzyTermMatch> {
    let max_distance = max_fuzzy_distance_for_term(query_term);
    let query_len = query_term.chars().count();
    let query_prefix = fuzzy_probe_prefix(query_term);
    let mut best: Option<FuzzyTermMatch> = None;

    for term in entry_terms {
        let term_len = term.chars().count();
        if query_len.abs_diff(term_len) > max_distance {
            continue;
        }
        if !query_prefix.is_empty() && !term.starts_with(query_prefix.as_str()) {
            continue;
        }

        let Some(distance) = bounded_levenshtein(query_term, term, max_distance) else {
            continue;
        };
        let candidate = FuzzyTermMatch {
            query_term: query_term.to_string(),
            matched_term: term.clone(),
            distance,
        };

        let candidate_similarity = fuzzy_similarity(query_term, term, distance);
        let should_replace = match &best {
            Some(existing) => {
                distance < existing.distance
                    || (distance == existing.distance
                        && candidate_similarity
                            > fuzzy_similarity(
                                query_term,
                                &existing.matched_term,
                                existing.distance,
                            ))
            }
            None => true,
        };

        if should_replace {
            best = Some(candidate);
        }
    }

    best
}

fn fuzzy_probe_prefix(term: &str) -> String {
    let len = term.chars().count();
    let prefix_len = if len >= 8 {
        2
    } else if len >= 5 {
        1
    } else {
        0
    };
    term.chars().take(prefix_len).collect()
}

fn max_fuzzy_distance_for_term(term: &str) -> usize {
    match term.chars().count() {
        0..=4 => 1,
        5..=8 => MAX_FUZZY_DISTANCE,
        _ => MAX_FUZZY_DISTANCE,
    }
}

fn bounded_levenshtein(left: &str, right: &str, max_distance: usize) -> Option<usize> {
    if left == right {
        return Some(0);
    }

    let left_chars = left.chars().collect::<Vec<_>>();
    let right_chars = right.chars().collect::<Vec<_>>();
    if left_chars.len().abs_diff(right_chars.len()) > max_distance {
        return None;
    }

    let mut previous = (0..=right_chars.len()).collect::<Vec<_>>();
    let mut current = vec![0usize; right_chars.len() + 1];

    for (left_index, left_char) in left_chars.iter().enumerate() {
        current[0] = left_index + 1;
        let mut row_min = current[0];

        for (right_index, right_char) in right_chars.iter().enumerate() {
            let substitution_cost = usize::from(left_char != right_char);
            current[right_index + 1] = (previous[right_index + 1] + 1)
                .min(current[right_index] + 1)
                .min(previous[right_index] + substitution_cost);
            row_min = row_min.min(current[right_index + 1]);
        }

        if row_min > max_distance {
            return None;
        }

        std::mem::swap(&mut previous, &mut current);
    }

    let distance = previous[right_chars.len()];
    (distance <= max_distance).then_some(distance)
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_optional_str(value: Option<&str>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_tag(value: Option<&str>) -> Option<String> {
    value.and_then(|tag| {
        let normalized = tag.trim().to_lowercase();
        if normalized.is_empty() {
            None
        } else {
            Some(normalized)
        }
    })
}

fn tokenize_query(query: Option<&str>) -> Vec<String> {
    query
        .unwrap_or_default()
        .split_whitespace()
        .filter_map(|term| {
            let cleaned = term
                .trim_matches(|ch: char| ch.is_ascii_punctuation())
                .trim()
                .to_lowercase();
            if cleaned.is_empty() {
                None
            } else {
                Some(cleaned)
            }
        })
        .collect()
}

fn build_fts_query(query_terms: &[String]) -> Option<String> {
    if query_terms.is_empty() {
        return None;
    }

    Some(
        query_terms
            .iter()
            .map(|term| format!("\"{}\"", term.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" AND "),
    )
}

fn normalize_limit(limit: i64) -> i64 {
    limit.clamp(1, 500)
}

fn normalize_embedding(embedding: Option<Vec<f64>>) -> Option<Vec<f64>> {
    embedding.and_then(|values| {
        if values.is_empty() || values.iter().any(|value| !value.is_finite()) {
            None
        } else {
            Some(values)
        }
    })
}

fn cosine_similarity(left: &[f64], right: &[f64]) -> f64 {
    if left.is_empty() || left.len() != right.len() {
        return 0.0;
    }

    let mut dot = 0.0;
    let mut left_norm = 0.0;
    let mut right_norm = 0.0;

    for (&l, &r) in left.iter().zip(right.iter()) {
        dot += l * r;
        left_norm += l * l;
        right_norm += r * r;
    }

    let denominator = left_norm.sqrt() * right_norm.sqrt();
    if denominator == 0.0 {
        0.0
    } else {
        dot / denominator
    }
}

fn parse_entry_embedding(conn: &Connection, entry_id: &str) -> Option<Vec<f64>> {
    let bytes: Vec<u8> = conn
        .query_row(
            "SELECT embedding FROM vec_entries WHERE entry_id = ?1",
            rusqlite::params![entry_id],
            |row| row.get(0),
        )
        .ok()?;
    if bytes.len() % 4 != 0 || bytes.is_empty() {
        return None;
    }
    let floats: Vec<f64> = bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) as f64)
        .collect();
    if floats.is_empty() || floats.iter().any(|v| !v.is_finite()) {
        None
    } else {
        Some(floats)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{insert_entry, NewEntry};

    static INIT_VEC: std::sync::Once = std::sync::Once::new();
    fn ensure_vec_extension() {
        INIT_VEC.call_once(|| unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        });
    }

    fn setup_conn() -> Connection {
        ensure_vec_extension();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE entries (
                id             TEXT PRIMARY KEY,
                content        TEXT NOT NULL,
                html_content   TEXT,
                source         TEXT NOT NULL DEFAULT 'clipboard',
                source_app     TEXT,
                created_at     INTEGER NOT NULL,
                pinned         INTEGER NOT NULL DEFAULT 0,
                label          TEXT,
                label_score    REAL,
                summary        TEXT,
                tags_json      TEXT,
                enrichment_tags TEXT,
                processing_diagnostics TEXT,
                manual_badges  TEXT,
                secret_verdict TEXT,
                secret_type    TEXT,
                secret_source  TEXT,
                collection_id  TEXT,
                checklist_completed INTEGER NOT NULL DEFAULT 0,
                is_note        INTEGER NOT NULL DEFAULT 0,
                import_origin  TEXT,
                import_name    TEXT,
                content_type   TEXT,
                attachment_rel_path TEXT,
                attachment_size_bytes INTEGER,
                attachment_sha256 TEXT,
                collection_sort_order INTEGER
            );
            ",
        )
        .unwrap();
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries USING vec0(
                entry_id TEXT PRIMARY KEY,
                embedding float[3] distance_metric=cosine
            );",
        )
        .unwrap();
        ensure_search_schema(&conn).unwrap();
        conn
    }

    fn insert_test_embedding(conn: &Connection, entry_id: &str, embedding_json: &str) {
        let floats: Vec<f32> = serde_json::from_str(embedding_json).unwrap();
        let bytes: Vec<u8> = floats.iter().flat_map(|f| f.to_le_bytes()).collect();
        conn.execute(
            "INSERT OR REPLACE INTO vec_entries(entry_id, embedding) VALUES (?1, ?2)",
            params![entry_id, bytes],
        )
        .unwrap();
    }

    fn sample_entry(
        id: &str,
        content: &str,
        source: &str,
        created_at: i64,
        is_note: bool,
    ) -> NewEntry {
        NewEntry {
            id: id.to_string(),
            content: content.to_string(),
            html_content: None,
            source: source.to_string(),
            source_app: Some("Slack".to_string()),
            created_at,
            collection_id: if is_note {
                Some("notes".to_string())
            } else {
                None
            },
            is_note,
            import_origin: None,
            import_name: Some("notes.md".to_string()),
            content_type: Some("text/plain".to_string()),
            attachment_rel_path: None,
            attachment_size_bytes: None,
            attachment_sha256: None,
        }
    }

    fn insert_search_entry(conn: &Connection, entry: NewEntry) {
        let entry_id = entry.id.clone();
        insert_entry(conn, &entry).unwrap();
        sync_entry_search_data(conn, &entry_id).unwrap();
    }

    #[test]
    fn deserializes_search_filters_from_snake_case_payload() {
        let filters: SearchFilters = serde_json::from_value(serde_json::json!({
            "scope": "notes",
            "source": "clipboard",
            "collection_id": "notes",
            "source_app": "VS Code",
            "tag": "important",
            "related_to": "anchor-id",
            "date_from": 100,
            "date_to": 200,
            "is_note": true
        }))
        .unwrap();

        assert_eq!(filters.scope.as_deref(), Some("notes"));
        assert_eq!(filters.source.as_deref(), Some("clipboard"));
        assert_eq!(filters.collection_id.as_deref(), Some("notes"));
        assert_eq!(filters.source_app.as_deref(), Some("VS Code"));
        assert_eq!(filters.tag.as_deref(), Some("important"));
        assert_eq!(filters.related_to.as_deref(), Some("anchor-id"));
        assert_eq!(filters.date_from, Some(100));
        assert_eq!(filters.date_to, Some(200));
        assert_eq!(filters.is_note, Some(true));
    }

    #[test]
    fn deserializes_search_filters_from_camel_case_payload() {
        let filters: SearchFilters = serde_json::from_value(serde_json::json!({
            "scope": "notes",
            "source": "clipboard",
            "collectionId": "notes",
            "sourceApp": "VS Code",
            "tag": "important",
            "relatedTo": "anchor-id",
            "dateFrom": 100,
            "dateTo": 200,
            "isNote": true
        }))
        .unwrap();

        assert_eq!(filters.scope.as_deref(), Some("notes"));
        assert_eq!(filters.source.as_deref(), Some("clipboard"));
        assert_eq!(filters.collection_id.as_deref(), Some("notes"));
        assert_eq!(filters.source_app.as_deref(), Some("VS Code"));
        assert_eq!(filters.tag.as_deref(), Some("important"));
        assert_eq!(filters.related_to.as_deref(), Some("anchor-id"));
        assert_eq!(filters.date_from, Some(100));
        assert_eq!(filters.date_to, Some(200));
        assert_eq!(filters.is_note, Some(true));
    }

    #[test]
    fn rebuilds_indexes_and_filters_by_exact_tag() {
        let conn = setup_conn();

        let first = sample_entry("entry-1", "Rust search foundation", "manual", 10, true);
        insert_entry(&conn, &first).unwrap();
        conn.execute(
            "UPDATE entries SET label = 'code', manual_badges = '[{\"name\":\"important\",\"color\":\"default\"}]' WHERE id = ?1",
            params![first.id],
        )
        .unwrap();
        sync_entry_search_data(&conn, &first.id).unwrap();

        let second = sample_entry("entry-2", "Garden checklist", "clipboard", 20, false);
        insert_entry(&conn, &second).unwrap();
        rebuild_all_search_indexes(&conn).unwrap();

        let results = search_entries_with_conn(
            &conn,
            Some("rust".to_string()),
            SearchFilters {
                scope: Some("notes".to_string()),
                tag: Some("important".to_string()),
                ..SearchFilters::default()
            },
            10,
            SearchMode::Keyword,
            None,
            RankingConfig::default(),
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entry.id, "entry-1");
        assert!(results[0].matched_tags.iter().any(|tag| tag == "important"));
    }

    #[test]
    fn filters_by_source_app_and_date_range() {
        let conn = setup_conn();

        let mut first = sample_entry("entry-early", "meeting notes", "manual", 100, true);
        first.source_app = Some("Notion".to_string());
        insert_entry(&conn, &first).unwrap();

        let mut second = sample_entry("entry-late", "meeting recap", "clipboard", 500, false);
        second.source_app = Some("Slack".to_string());
        insert_entry(&conn, &second).unwrap();

        let results = search_entries_with_conn(
            &conn,
            Some("meeting".to_string()),
            SearchFilters {
                source_app: Some("slack".to_string()),
                date_from: Some(200),
                date_to: Some(600),
                ..SearchFilters::default()
            },
            10,
            SearchMode::Keyword,
            None,
            RankingConfig::default(),
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entry.id, "entry-late");
        assert_eq!(results[0].match_type, "keyword");
    }

    #[test]
    fn lists_distinct_manual_badge_suggestions_from_entry_tags() {
        let conn = setup_conn();

        let first = sample_entry("entry-1", "Badge source one", "manual", 10, true);
        insert_entry(&conn, &first).unwrap();
        conn.execute(
            "UPDATE entries SET label = 'code', manual_badges = '[{\"name\":\"urgent\",\"color\":\"default\"},{\"name\":\"work\",\"color\":\"blue\"}]' WHERE id = ?1",
            params![first.id],
        )
        .unwrap();
        sync_entry_search_data(&conn, &first.id).unwrap();

        let second = sample_entry("entry-2", "Badge source two", "manual", 20, true);
        insert_entry(&conn, &second).unwrap();
        conn.execute(
            "UPDATE entries SET label = 'personal', manual_badges = '[{\"name\":\"work\",\"color\":\"green\"},{\"name\":\"later\",\"color\":\"default\"}]' WHERE id = ?1",
            params![second.id],
        )
        .unwrap();
        sync_entry_search_data(&conn, &second.id).unwrap();

        let suggestions = list_manual_badge_suggestions_with_conn(&conn).unwrap();

        assert_eq!(suggestions, vec!["later", "urgent", "work"]);
    }

    #[test]
    fn badge_suggestions_include_auto_and_manual_tags() {
        let conn = setup_conn();

        let first = sample_entry("entry-1", "Badge source one", "manual", 10, true);
        insert_entry(&conn, &first).unwrap();
        conn.execute(
            "UPDATE entries SET label = 'code', manual_badges = '[{\"name\":\"urgent\",\"color\":\"default\"}]' WHERE id = ?1",
            params![first.id],
        )
        .unwrap();
        sync_entry_search_data(&conn, &first.id).unwrap();

        let second = sample_entry("entry-2", "Badge source two", "manual", 20, true);
        insert_entry(&conn, &second).unwrap();
        conn.execute(
            "UPDATE entries SET label = 'personal', manual_badges = '[{\"name\":\"later\",\"color\":\"default\"}]' WHERE id = ?1",
            params![second.id],
        )
        .unwrap();
        sync_entry_search_data(&conn, &second.id).unwrap();

        let suggestions =
            list_badge_suggestions_with_conn(&conn, None, None, RankingConfig::default()).unwrap();

        assert_eq!(suggestions, vec!["code", "later", "personal", "urgent"]);
    }

    #[test]
    fn badge_suggestions_follow_search_hybrid_ranking() {
        let conn = setup_conn();

        let exact_recent = sample_entry(
            "exact-recent-tag",
            "Rust hybrid ranking foundations",
            "manual",
            500,
            true,
        );
        insert_entry(&conn, &exact_recent).unwrap();
        conn.execute(
            "UPDATE entries SET label = 'search', manual_badges = '[{\"name\":\"rusty\",\"color\":\"default\"}]' WHERE id = ?1",
            params![exact_recent.id],
        )
        .unwrap();
        insert_test_embedding(&conn, &exact_recent.id, "[1.0, 0.0, 0.0]");
        sync_entry_search_data(&conn, &exact_recent.id).unwrap();

        let semantic_only = sample_entry(
            "semantic-only-tag",
            "Vector retrieval concept note",
            "manual",
            400,
            true,
        );
        insert_entry(&conn, &semantic_only).unwrap();
        conn.execute(
            "UPDATE entries SET label = 'vectors', manual_badges = '[{\"name\":\"semantic\",\"color\":\"default\"}]' WHERE id = ?1",
            params![semantic_only.id],
        )
        .unwrap();
        insert_test_embedding(&conn, &semantic_only.id, "[0.97, 0.03, 0.0]");
        sync_entry_search_data(&conn, &semantic_only.id).unwrap();

        let old_keyword = sample_entry(
            "old-keyword-tag",
            "Rust hybrid ranking foundations",
            "manual",
            100,
            true,
        );
        insert_entry(&conn, &old_keyword).unwrap();
        conn.execute(
            "UPDATE entries SET label = 'archive', manual_badges = '[{\"name\":\"legacy\",\"color\":\"default\"}]' WHERE id = ?1",
            params![old_keyword.id],
        )
        .unwrap();
        insert_test_embedding(&conn, &old_keyword.id, "[0.7, 0.3, 0.0]");
        sync_entry_search_data(&conn, &old_keyword.id).unwrap();

        let suggestions = list_badge_suggestions_with_conn(
            &conn,
            Some("rust hybrid ranking".to_string()),
            Some(vec![1.0, 0.0, 0.0]),
            RankingConfig::default(),
        )
        .unwrap();

        assert_eq!(suggestions[0], "search");
        assert_eq!(suggestions[1], "rusty");
        assert!(
            suggestions
                .iter()
                .position(|tag| tag == "semantic")
                .unwrap()
                < suggestions.iter().position(|tag| tag == "legacy").unwrap()
        );
    }

    #[test]
    fn keyword_search_keeps_exact_lexical_matches() {
        let conn = setup_conn();

        insert_search_entry(
            &conn,
            sample_entry(
                "exact-lexical",
                "Search improvement checklist",
                "manual",
                100,
                true,
            ),
        );

        let results = search_entries_with_conn(
            &conn,
            Some("improvement".to_string()),
            SearchFilters::default(),
            10,
            SearchMode::Keyword,
            None,
            RankingConfig::default(),
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entry.id, "exact-lexical");
        assert!(results[0]
            .match_reasons
            .iter()
            .any(|reason| reason == "exact"));
    }

    #[test]
    fn keyword_search_supports_prefix_matches() {
        let conn = setup_conn();

        insert_search_entry(
            &conn,
            sample_entry(
                "prefix-hit",
                "Search improvement checklist",
                "manual",
                100,
                true,
            ),
        );

        let results = search_entries_with_conn(
            &conn,
            Some("improv".to_string()),
            SearchFilters::default(),
            10,
            SearchMode::Keyword,
            None,
            RankingConfig::default(),
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entry.id, "prefix-hit");
        assert!(results[0]
            .match_reasons
            .iter()
            .any(|reason| reason == "prefix"));
    }

    #[test]
    fn keyword_search_supports_fuzzy_matches() {
        let conn = setup_conn();

        insert_search_entry(
            &conn,
            sample_entry(
                "fuzzy-hit",
                "Search improvement checklist",
                "manual",
                100,
                true,
            ),
        );

        let results = search_entries_with_conn(
            &conn,
            Some("improvemnt".to_string()),
            SearchFilters::default(),
            10,
            SearchMode::Keyword,
            None,
            RankingConfig::default(),
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entry.id, "fuzzy-hit");
        assert!(results[0]
            .match_reasons
            .iter()
            .any(|reason| reason == "fuzzy"));
    }

    #[test]
    fn keyword_search_orders_exact_before_prefix_before_fuzzy() {
        let conn = setup_conn();

        insert_search_entry(
            &conn,
            sample_entry("exact-hit", "improvement", "manual", 300, true),
        );
        insert_search_entry(
            &conn,
            sample_entry("prefix-hit", "improvementplan", "manual", 200, true),
        );
        insert_search_entry(
            &conn,
            sample_entry("fuzzy-hit", "improvemant", "manual", 100, true),
        );

        let results = search_entries_with_conn(
            &conn,
            Some("improvement".to_string()),
            SearchFilters::default(),
            10,
            SearchMode::Keyword,
            None,
            RankingConfig::default(),
        )
        .unwrap();

        assert_eq!(results.len(), 3);
        assert_eq!(results[0].entry.id, "exact-hit");
        assert_eq!(results[1].entry.id, "prefix-hit");
        assert_eq!(results[2].entry.id, "fuzzy-hit");
        assert!(results[0]
            .match_reasons
            .iter()
            .any(|reason| reason == "exact"));
        assert!(results[1]
            .match_reasons
            .iter()
            .any(|reason| reason == "prefix"));
        assert!(results[2]
            .match_reasons
            .iter()
            .any(|reason| reason == "fuzzy"));
    }

    #[test]
    fn semantic_search_scores_filtered_candidates_server_side() {
        let conn = setup_conn();

        let note_match = sample_entry(
            "note-match",
            "Rust vector search foundations",
            "manual",
            100,
            true,
        );
        insert_entry(&conn, &note_match).unwrap();
        conn.execute(
            "UPDATE entries SET label = 'search' WHERE id = ?1",
            params![note_match.id],
        )
        .unwrap();
        insert_test_embedding(&conn, &note_match.id, "[1.0, 0.0, 0.0]");
        sync_entry_search_data(&conn, &note_match.id).unwrap();

        let note_far = sample_entry("note-far", "Gardening notes", "manual", 90, true);
        insert_entry(&conn, &note_far).unwrap();
        conn.execute(
            "UPDATE entries SET label = 'garden' WHERE id = ?1",
            params![note_far.id],
        )
        .unwrap();
        insert_test_embedding(&conn, &note_far.id, "[0.0, 1.0, 0.0]");
        sync_entry_search_data(&conn, &note_far.id).unwrap();

        let clipboard_match = sample_entry(
            "clipboard-match",
            "Rust clipboard item",
            "clipboard",
            110,
            false,
        );
        insert_entry(&conn, &clipboard_match).unwrap();
        insert_test_embedding(&conn, &clipboard_match.id, "[1.0, 0.0, 0.0]");
        sync_entry_search_data(&conn, &clipboard_match.id).unwrap();

        let results = search_entries_with_conn(
            &conn,
            Some("rust vectors".to_string()),
            SearchFilters {
                is_note: Some(true),
                ..SearchFilters::default()
            },
            10,
            SearchMode::Semantic,
            Some(vec![1.0, 0.0, 0.0]),
            RankingConfig::default(),
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entry.id, "note-match");
        assert_eq!(results[0].match_type, "semantic");
        assert_eq!(
            results[0].diagnostics.search_mode,
            Some(SearchMode::Semantic)
        );
        assert!(results.iter().all(|result| result.entry.is_note));
        assert!(results
            .iter()
            .all(|result| result.entry.id != "clipboard-match"));
    }

    #[test]
    fn collection_filter_is_orthogonal_to_source_filter() {
        let conn = setup_conn();

        let manual_note = sample_entry("manual-note", "rust note", "manual", 100, true);
        insert_entry(&conn, &manual_note).unwrap();
        sync_entry_search_data(&conn, &manual_note.id).unwrap();

        let clipboard_note = sample_entry("clipboard-note", "rust note", "clipboard", 90, true);
        insert_entry(&conn, &clipboard_note).unwrap();
        sync_entry_search_data(&conn, &clipboard_note.id).unwrap();

        let results = search_entries_with_conn(
            &conn,
            Some("rust".to_string()),
            SearchFilters {
                collection_id: Some("notes".to_string()),
                source: Some("manual".to_string()),
                ..SearchFilters::default()
            },
            10,
            SearchMode::Keyword,
            None,
            RankingConfig::default(),
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entry.id, "manual-note");
        assert_eq!(results[0].entry.collection_id.as_deref(), Some("notes"));
        assert_eq!(results[0].entry.source, "manual");
    }

    #[test]
    fn hybrid_search_blends_keyword_semantic_and_recency() {
        let conn = setup_conn();

        let exact_recent = sample_entry(
            "exact-recent",
            "Rust hybrid ranking foundations",
            "manual",
            500,
            true,
        );
        insert_entry(&conn, &exact_recent).unwrap();
        conn.execute(
            "UPDATE entries SET label = 'search' WHERE id = ?1",
            params![exact_recent.id],
        )
        .unwrap();
        insert_test_embedding(&conn, &exact_recent.id, "[1.0, 0.0, 0.0]");
        sync_entry_search_data(&conn, &exact_recent.id).unwrap();

        let semantic_only = sample_entry(
            "semantic-only",
            "Vector retrieval concept note",
            "manual",
            400,
            true,
        );
        insert_entry(&conn, &semantic_only).unwrap();
        conn.execute(
            "UPDATE entries SET label = 'search' WHERE id = ?1",
            params![semantic_only.id],
        )
        .unwrap();
        insert_test_embedding(&conn, &semantic_only.id, "[0.97, 0.03, 0.0]");
        sync_entry_search_data(&conn, &semantic_only.id).unwrap();

        let old_keyword = sample_entry(
            "old-keyword",
            "Rust hybrid ranking foundations",
            "manual",
            100,
            true,
        );
        insert_entry(&conn, &old_keyword).unwrap();
        insert_test_embedding(&conn, &old_keyword.id, "[0.7, 0.3, 0.0]");
        sync_entry_search_data(&conn, &old_keyword.id).unwrap();

        let results = search_entries_with_conn(
            &conn,
            Some("rust hybrid ranking".to_string()),
            SearchFilters {
                is_note: Some(true),
                ..SearchFilters::default()
            },
            10,
            SearchMode::Hybrid,
            Some(vec![1.0, 0.0, 0.0]),
            RankingConfig::default(),
        )
        .unwrap();

        assert_eq!(results[0].entry.id, "exact-recent");
        assert_eq!(results[0].diagnostics.search_mode, Some(SearchMode::Hybrid));
        assert!(results[0].diagnostics.keyword_rank.is_some());
        assert!(results[0].diagnostics.semantic_rank.is_some());
        assert!(results[0].diagnostics.keyword_weight.is_some());
        assert!(results[0].diagnostics.semantic_weight.is_some());
        assert!(results[0].diagnostics.keyword_rrf_score.is_some());
        assert!(results[0].diagnostics.semantic_rrf_score.is_some());
        assert_eq!(results[0].diagnostics.recency_max_boost, Some(0.02));
        assert_eq!(results[0].diagnostics.rrf_k, Some(10.0));
        assert!(results[0].diagnostics.recency_boost.unwrap_or_default() > 0.0);
        assert!(results[0].diagnostics.fused_score.unwrap_or_default() > 0.0);
        assert!(results[0]
            .match_reasons
            .iter()
            .any(|reason| reason == "keyword"));
        assert!(results[0]
            .match_reasons
            .iter()
            .any(|reason| reason == "semantic"));
    }

    #[test]
    fn semantic_search_falls_back_to_keyword_when_embedding_missing() {
        let conn = setup_conn();

        let entry = sample_entry(
            "entry-1",
            "semantic fallback keyword match",
            "manual",
            10,
            true,
        );
        insert_entry(&conn, &entry).unwrap();

        let results = search_entries_with_conn(
            &conn,
            Some("fallback keyword".to_string()),
            SearchFilters {
                is_note: Some(true),
                ..SearchFilters::default()
            },
            10,
            SearchMode::Semantic,
            None,
            RankingConfig::default(),
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].match_type, "keyword");
        assert_eq!(
            results[0].diagnostics.semantic_fallback_reason.as_deref(),
            Some("missing_query_embedding")
        );
    }

    #[test]
    fn related_entries_use_semantic_neighbors_when_available() {
        let conn = setup_conn();

        let anchor = sample_entry("anchor", "anchor note", "manual", 200, true);
        insert_entry(&conn, &anchor).unwrap();
        conn.execute(
            "UPDATE entries SET label = 'search' WHERE id = ?1",
            params![anchor.id],
        )
        .unwrap();
        insert_test_embedding(&conn, &anchor.id, "[1.0, 0.0, 0.0]");
        sync_entry_search_data(&conn, &anchor.id).unwrap();

        let close = sample_entry("close", "close note", "manual", 150, true);
        insert_entry(&conn, &close).unwrap();
        insert_test_embedding(&conn, &close.id, "[0.9, 0.1, 0.0]");
        sync_entry_search_data(&conn, &close.id).unwrap();

        let far = sample_entry("far", "far note", "manual", 160, true);
        insert_entry(&conn, &far).unwrap();
        insert_test_embedding(&conn, &far.id, "[0.0, 1.0, 0.0]");
        sync_entry_search_data(&conn, &far.id).unwrap();

        let results = get_related_entries_with_conn(
            &conn,
            "anchor",
            SearchFilters::default(),
            5,
            RankingConfig::default(),
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].entry.id, "close");
        assert_eq!(results[0].match_type, "related_semantic");
        assert!(results[0]
            .match_reasons
            .iter()
            .any(|reason| reason == "semantic"));
        assert!(results.iter().all(|result| result.entry.id != "anchor"));
    }

    #[test]
    fn search_filter_related_to_limits_results_to_anchor_and_related_neighbors() {
        let conn = setup_conn();

        let anchor = sample_entry("anchor", "anchor note", "manual", 200, true);
        insert_entry(&conn, &anchor).unwrap();
        conn.execute(
            "UPDATE entries SET label = 'code', source_app = 'Related Filter App' WHERE id = ?1",
            params![anchor.id],
        )
        .unwrap();
        insert_test_embedding(&conn, &anchor.id, "[1.0, 0.0, 0.0]");
        sync_entry_search_data(&conn, &anchor.id).unwrap();

        let close = sample_entry("close", "close note", "manual", 150, true);
        insert_entry(&conn, &close).unwrap();
        conn.execute(
            "UPDATE entries SET label = 'code', source_app = 'Related Filter App' WHERE id = ?1",
            params![close.id],
        )
        .unwrap();
        insert_test_embedding(&conn, &close.id, "[0.9, 0.1, 0.0]");
        sync_entry_search_data(&conn, &close.id).unwrap();

        let far = sample_entry("far", "far note", "manual", 160, true);
        insert_entry(&conn, &far).unwrap();
        conn.execute(
            "UPDATE entries SET label = 'ops', source_app = 'Related Filter App' WHERE id = ?1",
            params![far.id],
        )
        .unwrap();
        insert_test_embedding(&conn, &far.id, "[0.0, 1.0, 0.0]");
        sync_entry_search_data(&conn, &far.id).unwrap();

        let results = search_entries_with_conn(
            &conn,
            None,
            SearchFilters {
                is_note: Some(true),
                related_to: Some("anchor".to_string()),
                ..SearchFilters::default()
            },
            10,
            SearchMode::Keyword,
            None,
            RankingConfig::default(),
        )
        .unwrap();

        let ids = results
            .into_iter()
            .map(|result| result.entry.id)
            .collect::<Vec<_>>();
        assert!(ids.contains(&"anchor".to_string()));
        assert!(ids.contains(&"close".to_string()));
        assert!(!ids.contains(&"far".to_string()));
    }
}
