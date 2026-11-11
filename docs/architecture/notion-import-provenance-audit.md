# Read-only audit: historical Notion import provenance

Earlier imports treated `Parent item` as a translation relation and allowed more
than one Notion page to target the same article and locale. A later import could
therefore replace one page's edition with another. The new importer does not
rewrite, delete or repair historical links automatically. Back up the database
before any manual investigation or correction.

Run these **read-only** queries as an authorized database operator on either
SQLite or PostgreSQL. Results contain author IDs, page IDs and article IDs; treat
and store them as private data. They identify *candidates*, not proof of damage:
inspect the source pages and the article in the desk before deciding what to do.
In particular, a current article cannot reconstruct overwritten historical text;
consult source exports or backups. No Notion token is required.

```sql
-- Multiple Notion pages linked to one article edition (possible overwrites).
SELECT owner_id, article_id, locale, COUNT(*) AS source_pages
FROM external_content_links
WHERE provider = 'notion'
GROUP BY owner_id, article_id, locale
HAVING COUNT(*) > 1
ORDER BY owner_id, article_id, locale;

-- One source page imported in several locales (possible duplicate works).
SELECT external_id, COUNT(*) AS links, COUNT(DISTINCT locale) AS locales,
       COUNT(DISTINCT article_id) AS articles, COUNT(DISTINCT owner_id) AS owners
FROM external_content_links
WHERE provider = 'notion'
GROUP BY external_id
HAVING COUNT(*) > 1
ORDER BY external_id;
```

After identifying a candidate, inspect its individual rows with a parameterized,
owner-scoped query and compare them with the original export. Do not delete links
or modify articles as an automated consequence of this report. Plan and test any
repair separately, including backups and author confirmation.

The importer's cross-locale checks are preflight reads, not a cross-locale atomic
uniqueness constraint. Concurrent imports can still race between the check and
article/link writes; failures between article and link writes can leave incomplete
provenance. A future persistence change must address those races and legacy
conflicts without silently rewriting data.
