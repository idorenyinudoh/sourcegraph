import { noop } from 'lodash'
import React, { useMemo } from 'react'
import * as uuid from 'uuid'

import { convertMarkdownToBlocks } from '../../search/notebook/convertMarkdownToBlocks'
import { SearchNotebook, SearchNotebookProps } from '../../search/notebook/SearchNotebook'

import styles from './RenderedSearchNotebookMarkdown.module.scss'

export const SEARCH_NOTEBOOK_FILE_EXTENSION = '.snb.md'

interface RenderedSearchNotebookMarkdownProps extends Omit<SearchNotebookProps, 'onSerializeBlocks' | 'blocks'> {
    markdown: string
}

export const RenderedSearchNotebookMarkdown: React.FunctionComponent<RenderedSearchNotebookMarkdownProps> = ({
    markdown,
    ...props
}) => {
    // Generate fresh block IDs, since we do not store them in Markdown.
    const blocks = useMemo(() => convertMarkdownToBlocks(markdown).map(block => ({ id: uuid.v4(), ...block })), [
        markdown,
    ])
    return (
        <div className={styles.renderedSearchNotebookMarkdownWrapper}>
            <div className={styles.renderedSearchNotebookMarkdown}>
                <SearchNotebook isReadOnly={true} blocks={blocks} {...props} onSerializeBlocks={noop} />
            </div>
        </div>
    )
}
