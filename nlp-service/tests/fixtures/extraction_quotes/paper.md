Attention Is Not All You Need for Small Data

Abstract

We study transformer models trained on fewer than ten thousand exam-
ples. Our results show that a two-layer LSTM matches the transformer's
accuracy on four of the six benchmarks [3], while training five times
faster on a single GPU.

1 Introduction

The transformer architecture, introduced by Vaswani et al. in 2017 [12],
replaced recurrence with self-attention. It is part of nearly every
large language model in use today, including GPT-4.

| Model | Accuracy | Hours |
|---|---|---|
| LSTM | 81.2 | 1.5 |
| Transformer | 81.9 | 7.4 |
