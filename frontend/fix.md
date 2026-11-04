# Frontend Fixes Required

1. `frontend/src/features/auth/coordination.ts`

- line 26:

```
└╴ coordination.ts  1 
  └╴ Type 'Promise<Promise<T>>' is not assignable to type 'Promise<T>'.
       Type 'Promise<T>' is not assignable to type 'T'.
         'T' could be instantiated with an arbitrary type which could be unrelated to 'Promise<T>'. ts (2322) [26, 39]
```


2. `./src/features/orders/useOrderObservation.ts`

- lines 18-19:

```
└╴ useOrderObservation.ts  2 
  ├╴ 'observer' implicitly has type 'any' because it does not have a type annotation and is referenced directly or indirectly in its own initializer. ts (7022) [18, 11]
  └╴ Function implicitly has return type 'any' because it does not have a return type annotation and is referenced directly or indirectly in one of its return expressions. ts (7024) [19, 7]
```

