# Architecture

## Core Philosophy

...

## Data Separation

Trade Shelf Agent は以下を明確に分ける。

1. Source Data  
   書類・メール・在庫・次便・顧客納期などの元データ

2. Agent Analysis  
   Incident / ImpactAnalysis / DecisionOptions など、AIまたはルールが生成した判断材料

3. Human Decision  
   承認・修正・分納扱い・次便紐付け・エスカレーションなど、人間が確定した業務判断

## Inventory Flow

倉庫着後は、TradeCase から直接在庫数を変更するのではなく、StockMovement として記録する。

- expectedInbound
- warehouseReceived
- allocated
- adjusted

## API-first Design

...

## Azure Architecture

...