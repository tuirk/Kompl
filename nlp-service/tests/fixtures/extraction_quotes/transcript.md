# How the Rust borrow checker works

**Channel:** Systems Talk
**Published:** 2023-11-02T15:00:00Z
**Duration:** PT12M

## Transcript

so today we're going to look at the borrow checker the borrow checker is the part of the rust compiler that makes sure references never outlive the data they point to and it was designed together with the ownership model by the rust team at mozilla research which is why people say rust gives you memory safety without a garbage collector unlike go which uses one
