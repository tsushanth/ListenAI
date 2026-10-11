# Test fixtures for the programmatic content library

Everything under this directory is TEST DATA written to exercise the loader, the validator and the page templates. It is not research:
the vendor facts are plausible placeholders and must never be published. The production loader reads `src/content` only; these files are
read only when `SEO_LIBRARY_DIR` points here (the tests in `test/seoLibrary` set it). Production builds do not set that variable.
