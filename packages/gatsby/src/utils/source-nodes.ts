import report from "gatsby-cli/lib/reporter"
import { Span } from "opentracing"
import apiRunner from "./api-runner-node"
import { store } from "../redux"
import { getDataStore, getNode, isLmdbStore } from "../datastore"
import { actions } from "../redux/actions"
import { IGatsbyNode } from "../redux/types"
import { IGatsbyIterable } from "../datastore/types"

const { deleteNode } = actions

/**
 * Finds the name of all plugins which implement Gatsby APIs that
 * may create nodes, but which have not actually created any nodes.
 */
function discoverPluginsWithoutNodes(): Array<string> {
  if (isLmdbStore() && getDataStore().countNodes() > 100000) {
    // This method is pretty expensive, especially with lmdb-store
    // TODO: count the number of nodes per plugin in reducers instead
    return []
  }

  // Find out which plugins own already created nodes
  const nodeOwnerSet = new Set([`default-site-plugin`])
  getDataStore()
    .iterateNodes()
    .forEach(node => nodeOwnerSet.add(node.internal.owner))

  return store
    .getState()
    .flattenedPlugins.filter(
      plugin =>
        // "Can generate nodes"
        plugin.nodeAPIs.includes(`sourceNodes`) &&
        // "Has not generated nodes"
        !nodeOwnerSet.has(plugin.name)
    )
    .map(plugin => plugin.name)
}

/**
 * Warn about plugins that should have created nodes but didn't.
 */
function warnForPluginsWithoutNodes(): void {
  const pluginsWithNoNodes = discoverPluginsWithoutNodes()

  pluginsWithNoNodes.map(name =>
    report.warn(
      `The ${name} plugin has generated no Gatsby nodes. Do you need it?`
    )
  )
}

/**
 * Return the set of nodes for which its root node has not been touched
 */
function getStaleNodes(): IGatsbyIterable<IGatsbyNode> {
  const state = store.getState()

  return getDataStore()
    .iterateNodes()
    .filter(node => {
      let rootNode = node
      let next: IGatsbyNode | undefined = undefined

      let whileCount = 0
      do {
        next = rootNode.parent ? getNode(rootNode.parent) : undefined
        if (next) {
          rootNode = next
        }
      } while (next && ++whileCount < 101)

      if (whileCount > 100) {
        console.log(
          `It looks like you have a node that's set its parent as itself`,
          rootNode
        )
      }

      return !state.nodesTouched.has(rootNode.id)
    })
}

/**
 * Find all stale nodes and delete them
 */
function deleteStaleNodes(): void {
  const staleNodes = getStaleNodes()
  staleNodes.forEach(node => store.dispatch(deleteNode(node)))
}

export default async ({
  webhookBody,
  pluginName,
  parentSpan,
  deferNodeMutation = false,
}: {
  webhookBody: unknown
  pluginName?: string
  parentSpan: Span
  deferNodeMutation: boolean
}): Promise<void> => {
  await apiRunner(`sourceNodes`, {
    traceId: `initial-sourceNodes`,
    waitForCascadingActions: true,
    deferNodeMutation,
    parentSpan,
    webhookBody: webhookBody || {},
    pluginName,
  })
  await getDataStore().ready()

  warnForPluginsWithoutNodes()
  deleteStaleNodes()
}
