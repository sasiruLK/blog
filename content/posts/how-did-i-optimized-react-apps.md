+++
title = "Understanding React Rendering and Re-renders"
description = "A practical guide to React’s rendering cycle, fibers, and how to avoid unnecessary re-renders."
date = 2022-01-01
updated = 2025-01-01
draft = false

[taxonomies]
tags = ["react", "performance"]
categories = ["frontend", "react"]

[extra]
lang = "en"
toc = true
comment = true
copy = true
math = false
mermaid = false
featured = false
reaction = true
+++

# React rendering
## React developer tools

You can download the React Developer Tools for most of the major browsers.

- [React Developer Tools for Chrome](https://chrome.google.com/webstore/detail/react-developer-tools/fmkadmapgofadopljbjfkapdkoienihi?hl=en)
- [React Developer Tools for Firefox](https://addons.mozilla.org/en-US/firefox/addon/react-devtools/)
- [React Developer Tools for Microsoft Edge](https://microsoftedge.microsoft.com/addons/detail/react-developer-tools/gpphkfbcpidddadnkolkpfckpihlkkil)

Once you have the extension installed, you'll see there is a new tab in your developer tools called ⚛️ Profiler. You can change the settings to record an explanation of why each component re-rendered in in the recording.

You can also have it highlight the parts of the DOM that re-render while you're kicking the tires on your application. Go in to the settings for the profiler and select "Highlight updates when components render."

This will get your a fun green rectangle around anything that is going through a re-render as you interact with your application.

## React rendering cycle

React starts at the root of the component tree and works its way downward in hopes of finding all of the components that need updating. It does this by calling each component with its current props and looking at the output to determine if anything has changed.

Once React has worked its way through the entire component tree, it compares this new tree to the current state of the world and figures out what it needs to do the DOM in order to get everything up to date.

Rendering is not the same as updating the DOM. You could render a component and have the results be exactly the same as it was last time, which means that we don't need to update the DOM.

### Phases

- Render phase is where we render everything and calculate all of the changes that we need to do in order to get everything up to date.
- Commit phase is where React goes ahead and makes those aforementioned changes to the DOM.
  - After React has updated the DOM, it updates all of the \`ref\`s to make sure they're pointing to the correct DOM nodes.
  - Next up, it synchronously runs the`useLayoutEffect` hooks.
  - Once this is all behind us, we move into the Passive Effects phase React then lets go on the main thread for a moment and pops a short timeout on the event loop before running all of the `useEffect` hooks.

React 18 introduced [concurrent rendering,](https://www.telerik.com/blogs/concurrent-rendering-react-18 'concurrent rendering') which brought with it features like `useTransition`.

The high-level is that this gives React the ability to pause work in the rendering phase to allow the browser to handle events. After it does this, React steps back in. Depending on what went down, it will either resume, throw away, or recalculate that work later. The commit phase then goes down as normal.

To my previous point about how rendering might not result in needing any updates to the DOM.

On Rendering

In order to kick off the render phase, one of the following has to go down:

\- The state is updated via either the `useState` or `useReducer` hooks.

\- Then calls a `ReactDOM.Root`'s render method again.

\- The `useExternalSyncStore` hook is called.

By default, a parent component renders, React will work its way down the component tree re-rendering all of the child components. It doesn't care if the props changed. The only requirement that React cares about is whether or not the parent component rendered, that enough to get a child component re-rendered. Now, that doesn't mean that the DOM is going to need to be updated in anyway, but this is how React comes that conclusion.

### On Committing

React calls the following during the **commit phase**: `useLayoutEffect`. But, it's important to note that it calls these hooks before it has had a chance to paint.

The browser won't paint anything while JavaScript is executing and blocking the event loop. It'll wait for you to finish. This is why React runs all of these synchronously.

### Fibers

React keeps track of all of the current component instances. One of the core pieces of this data structure called a fiber, which have been around since React 16. When a component is rendered for the first time, React goes ahead and creates a fiber object to track the component instance. React stores all of the hooks for a component as a linked list attached to that component's fiber.

Fibers are in charge of answering the following questions:

\- What type of component are we expecting at this point in the component tree? Was it a `div` last time and now its a `span`? Well, then we probably need to reconcile that.

\- What are the current props and state associated with this component instance?

\- Who are its parents, siblings, and children?

To the first bullet point, if React sees that a component type has changed, it will try to optimize for the likely scenario that this is a fundamentally different tree from this point forward and it will just toss the entire sub-tree out and start over. This is where doing crazy stuff like dynamically defining components inside of another one can get you into trouble. This will be a different component in memory and it will cause React to take drastic measures.

### Avoiding expensive state initialization

Let's say that you have some expensive function that you need to call in order to initialize your component or application.

```javascript
const [state, setState] = useState(expensiveFn())
```

Your component is a function that is called every render. This means you're going to call `expensiveFn()` every time. And you know what? It's expensive.

An alternative approach is to pass the `useState` a function to tell it how to initialize itself the first time

```javascript
const [state, setState] = useState(() => getExpensiveThing())
```

`useState` will call that function the first time it sets up `state` and `setState` and that's it.

## Reducing renders

### Pushing State Down & Pulling State Up

Dan Abramov well explained this on his blog. So I don't want to write about this. You can find the article [here](https://overreacted.io/before-you-memo/ 'here').

### Some more tools

React has hooks to help

- useMemo lets you cache the result of a calculation(a value basically) between re-renders.
- useCallback lets you cache a function definition between re-renders.

Let's check the function below.

```typescript
function handleAddTodo(text) {
  const newTodo = { id: nextId++, text }
  setTodos([...todos, newTodo])
}
```

So the thing here is we're re-creating these functions on every render. Above is an anonymous function each an every time and it's a different object in memory from the last time we whipped up a function.

But, things get a little bit trickier. We could try to wrap these functions in useCallback.

```typescript
const handleAddTodo = useCallback((text) => {
  const newTodo = { id: nextId++, text }
  setTodos([...todos, newTodo])
}, [todos])
```

It technically works, but it doesn't exactly do us a lot of good. The problem is that todos is really the only thing we're ever dealing with in this application and it's basically changing every time we do anything.

React will automatically pass the current version that you were working with when it goes to update the state. This mean, you don't need to pass a reference to it.

So what you could do is

```typescript
const handleAddTodo = useCallback((text) => {
  const newTodo = { id: nextId++, text }
  setTodos(todos => [...todos, newTodo])
}, [])
```

## Context

So let's say if you want to use context

```typescript
const TodoContext = createContext(initialContextValues)

function Todo() {
  const [state, dispatch] = useReducer(reducer, initialArg)
  return (
    <TodoContext.Provider value={{ state, dispatch }}>
      { children }
    </TodoContext>
  )
}

```

Now every children components are going to re-render every time state change. So the problem is we are putting state in a brand new object. That brand new object is not the same as previous one. Items or dispatch might be the same but the object is new. So it invalidates the useMemo or useCallback checks if you put those.

So what's the solution here ?

Two contexts

One context create our problem. So Two context is our way out. One for the things that change. One for the things that don't change.

```typescript
const TodoContext = createContext(initialTodoItems)
const ActionContext = createContext(initialDispatch)

function Todo() {
  const [state, dispatch] = useReducer(reducer, initialArg)
  return (
  <ActionContext.Provider value = { dispatch} >
    <TodoContext.Provider value = { state } >
      { children }
      </TodoContext>
  </ActionContext >
  )
}
```

Context order is important here. We have to put the one that doesn't change outside of one that change.

## Note From Dan

Never thought Dan himself would comment about my blog post, But here we are!

[https://bsky.app/profile/sasiru.lk/post/3kl6quo5v472f](https://bsky.app/profile/sasiru.lk/post/3kl6quo5v472f)
