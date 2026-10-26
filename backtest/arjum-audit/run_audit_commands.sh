#!/bin/bash
for t in BBCA BRPT GOTO ZYRX; do
  echo "$t $(ls /home/ubuntu/auto-cuan/data/arjum-data/broker-summary-F/$t 2>/dev/null | wc -l)"
done
