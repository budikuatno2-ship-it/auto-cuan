# AI Evaluation Pilot Fix

This patch prevents source-backed snapshot dates and times from being treated as invented price levels during deterministic answer evaluation.

The price/level grounding checks remain active for all other numeric values.
