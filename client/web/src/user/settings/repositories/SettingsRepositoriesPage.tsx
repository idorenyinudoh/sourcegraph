import AddIcon from 'mdi-react/AddIcon'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { EMPTY, Observable } from 'rxjs'
import { catchError, tap } from 'rxjs/operators'

import { LoadingSpinner } from '@sourcegraph/react-loading-spinner'
import { Link } from '@sourcegraph/shared/src/components/Link'
import { gql } from '@sourcegraph/shared/src/graphql/graphql'
import { TelemetryProps } from '@sourcegraph/shared/src/telemetry/telemetryService'
import { asError, ErrorLike, isErrorLike } from '@sourcegraph/shared/src/util/errors'
import { repeatUntil } from '@sourcegraph/shared/src/util/rxjs/repeatUntil'
import { useObservable } from '@sourcegraph/shared/src/util/useObservable'
import { ErrorAlert } from '@sourcegraph/web/src/components/alerts'
import { Badge } from '@sourcegraph/web/src/components/Badge'
import { queryExternalServices } from '@sourcegraph/web/src/components/externalServices/backend'
import {
    FilteredConnectionFilter,
    FilteredConnectionQueryArguments,
    Connection,
} from '@sourcegraph/web/src/components/FilteredConnection'
import { PageTitle } from '@sourcegraph/web/src/components/PageTitle'
import { SelfHostedCtaLink } from '@sourcegraph/web/src/components/SelfHostedCtaLink'
import { Container, PageHeader } from '@sourcegraph/wildcard'

import { requestGraphQL } from '../../../backend/graphql'
import {
    SiteAdminRepositoryFields,
    ExternalServicesResult,
    CodeHostSyncDueResult,
    CodeHostSyncDueVariables,
    RepositoriesResult,
} from '../../../graphql-operations'
import {
    listUserRepositories,
    listOrgRepositories,
    fetchUserRepositoriesCount,
    fetchOrgRepositoriesCount,
} from '../../../site-admin/backend'
import { eventLogger } from '../../../tracking/eventLogger'
import { UserExternalServicesOrRepositoriesUpdateProps } from '../../../util'

import { defaultFilters, RepositoriesList } from './RepositoriesList'

interface Props
    extends TelemetryProps,
        Pick<UserExternalServicesOrRepositoriesUpdateProps, 'onUserExternalServicesOrRepositoriesUpdate'> {
    ownerID: string
    ownerType: 'user' | 'org'
    routingPrefix: string
}

type SyncStatusOrError = undefined | 'scheduled' | 'schedule-complete' | ErrorLike

/**
 * A page displaying the repositories for this user.
 */
export const SettingsRepositoriesPage: React.FunctionComponent<Props> = ({
    ownerID,
    ownerType,
    routingPrefix,
    telemetryService,
    onUserExternalServicesOrRepositoriesUpdate,
}) => {
    const [hasRepos, setHasRepos] = useState(false)
    const [externalServices, setExternalServices] = useState<ExternalServicesResult['externalServices']['nodes']>()
    const [repoFilters, setRepoFilters] = useState<FilteredConnectionFilter[]>([])
    const [status, setStatus] = useState<SyncStatusOrError>()
    const [updateReposList, setUpdateReposList] = useState(false)

    const fetchRepositories = ownerType === 'user' ? listUserRepositories : listOrgRepositories
    const fetchRepositoriesCount = ownerType === 'user' ? fetchUserRepositoriesCount : fetchOrgRepositoriesCount

    const NoAddedReposBanner = (
        <Container className="text-center">
            <h4>You have not added any repositories to Sourcegraph.</h4>

            {externalServices?.length === 0 ? (
                <small>
                    <Link to={`${routingPrefix}/code-hosts`}>Connect a code host</Link> to add your code to Sourcegraph.
                    You can also <Link to={`${routingPrefix}/repositories/manage`}>add other public repositories</Link>{' '}
                    from GitHub or GitLab.
                </small>
            ) : (
                <small>
                    <Link to={`${routingPrefix}/repositories/manage`}>Add repositories</Link> to start searching your
                    code with Sourcegraph.
                </small>
            )}
        </Container>
    )

    const fetchExternalServices = useCallback(
        async (): Promise<ExternalServicesResult['externalServices']['nodes']> =>
            queryExternalServices({
                first: null,
                after: null,
                namespace: ownerID,
            })
                .toPromise()
                .then(({ nodes }) => nodes),

        [ownerID]
    )

    const fetchCodeHostSyncDueStatus = useCallback(
        (ids: string[], seconds: number) =>
            requestGraphQL<CodeHostSyncDueResult, CodeHostSyncDueVariables>(
                gql`
                    query CodeHostSyncDue($ids: [ID!]!, $seconds: Int!) {
                        codeHostSyncDue(ids: $ids, seconds: $seconds)
                    }
                `,
                { ids, seconds }
            ),
        []
    )

    const init = useCallback(async (): Promise<void> => {
        // fetch and set external services
        const services = await fetchExternalServices()
        setExternalServices(services)

        // check if user has any manually added or affiliated repositories
        const result = await fetchRepositoriesCount({
            id: ownerID,
        }) // fetchUserReposCount()
        const repoCount = result.node.repositories.totalCount || 0

        if (repoCount) {
            setHasRepos(true)
        }
        onUserExternalServicesOrRepositoriesUpdate(services.length, repoCount)

        // configure filters
        const specificCodeHostFilters = services.map(service => ({
            tooltip: '',
            value: service.id,
            label: service.displayName.split(' ')[0],
            args: { externalServiceID: service.id },
        }))

        const [statusFilter, codeHostFilter] = defaultFilters

        // update default code host filter by adding GitLab and/or GitHub filters
        const updatedCodeHostFilter = {
            ...codeHostFilter,
            values: [...codeHostFilter.values, ...specificCodeHostFilters],
        }

        setRepoFilters([statusFilter, updatedCodeHostFilter])
    }, [fetchExternalServices, fetchRepositoriesCount, onUserExternalServicesOrRepositoriesUpdate, ownerID])

    const TWO_SECONDS = 2

    useObservable(
        useMemo(() => {
            if (externalServices && externalServices.length !== 0) {
                // get serviceIds and check if services will sync in the next 2 seconds
                const serviceIds = externalServices.map(service => service.id)

                return fetchCodeHostSyncDueStatus(serviceIds, TWO_SECONDS).pipe(
                    repeatUntil(
                        result => {
                            const isScheduledToSync = result.data?.codeHostSyncDue === true
                            // if all existing code hosts were just added
                            // created and updated timestamps are the same
                            const areCodeHostsJustAdded = externalServices.every(
                                ({ updatedAt, createdAt, repoCount }) => updatedAt === createdAt && repoCount === 0
                            )

                            if (isScheduledToSync && !areCodeHostsJustAdded) {
                                setStatus('scheduled')
                            } else {
                                setStatus(previousState => {
                                    if (previousState === 'scheduled') {
                                        return 'schedule-complete'
                                    }

                                    return undefined
                                })
                            }

                            // don't repeat the query if the sync is not scheduled
                            // or code host(s) we just added
                            return !isScheduledToSync || areCodeHostsJustAdded
                        },
                        { delay: 2000 }
                    ),
                    catchError(error => {
                        setStatus(asError(error))
                        return EMPTY
                    })
                )
            }

            return EMPTY
        }, [externalServices, fetchCodeHostSyncDueStatus])
    )

    useEffect(() => {
        // don't re-fetch data when sync is scheduled or we had an error
        // we should fetch only on the page load or once the sync is complete
        if (status === 'scheduled' || isErrorLike(status)) {
            return
        }

        init().catch(error => setStatus(asError(error)))
    }, [init, status])

    const queryRepos = useCallback(
        (args: FilteredConnectionQueryArguments): Observable<NonNullable<RepositoriesResult>['repositories']> =>
            fetchRepositories({ ...args, id: ownerID }).pipe(
                tap(() => {
                    if (status === 'schedule-complete') {
                        setUpdateReposList(!updateReposList)
                        setStatus(undefined)
                    }
                })
            ),
        [ownerID, status, updateReposList, fetchRepositories]
    )

    const onRepoQueryUpdate = useCallback(
        (value: Connection<SiteAdminRepositoryFields> | ErrorLike | undefined, query: string): void => {
            if (value as Connection<SiteAdminRepositoryFields>) {
                const conn = value as Connection<SiteAdminRepositoryFields>

                // hasRepos is only useful when query is not set since user may
                // still have repos that don't match given query
                if (query === '') {
                    if (conn.totalCount !== 0 || conn.nodes.length !== 0) {
                        setHasRepos(true)
                    } else {
                        setHasRepos(false)
                    }
                }
            }
        },
        []
    )

    const logManageRepositoriesClick = useCallback(() => {
        eventLogger.log('UserSettingsRepositoriesManageRepositoriesClick')
    }, [])

    useEffect(() => {
        telemetryService.logViewEvent('UserSettingsRepositories')
    }, [telemetryService])

    const getCodeHostsSyncMessage = (): string => {
        if (Array.isArray(externalServices) && externalServices) {
            const names = externalServices.map(service => {
                const { displayName: name } = service
                const namespaceStartIndex = name.indexOf('(')

                return namespaceStartIndex !== -1 ? name.slice(0, namespaceStartIndex - 1) : name
            })

            return `Syncing ${names.join(', ')} code host${names.length > 1 ? 's' : ''}.`
        }
        return 'Syncing code hosts.'
    }

    return (
        <div className="user-settings-repos">
            <SelfHostedCtaLink
                className="user-settings-repos__self-hosted-cta"
                telemetryService={telemetryService}
                page="settings/repositories"
            />
            {status === 'scheduled' && (
                <div className="alert alert-info">
                    <span className="font-weight-bold">{getCodeHostsSyncMessage()}</span> Repositories list may not be
                    up-to-date and will refresh once the sync is finished.
                </div>
            )}
            {isErrorLike(status) && <ErrorAlert error={status} icon={true} />}
            <PageTitle title="Your repositories" />
            <PageHeader
                headingElement="h2"
                path={[
                    {
                        text: (
                            <div className="d-flex">
                                Your repositories <Badge status="beta" className="ml-2" />
                            </div>
                        ),
                    },
                ]}
                description={
                    <div className="text-muted">
                        All repositories synced with Sourcegraph from your{' '}
                        <Link to={`${routingPrefix}/code-hosts`}>connected code hosts</Link>
                    </div>
                }
                actions={
                    <Link
                        className="btn btn-primary"
                        to={`${routingPrefix}/repositories/manage`}
                        onClick={logManageRepositoriesClick}
                    >
                        {(hasRepos && <>Manage Repositories</>) || (
                            <>
                                <AddIcon className="icon-inline" /> Add repositories
                            </>
                        )}
                    </Link>
                }
                className="mb-3"
            />
            {isErrorLike(status) ? (
                <h3 className="text-muted">Sorry, we couldn’t fetch your repositories. Try again?</h3>
            ) : !externalServices ? (
                <div className="d-flex justify-content-center mt-4">
                    <LoadingSpinner className="icon-inline" />
                </div>
            ) : hasRepos ? (
                <RepositoriesList
                    queryRepos={queryRepos}
                    updateReposList={updateReposList}
                    onRepoQueryUpdate={onRepoQueryUpdate}
                    repoFilters={repoFilters}
                />
            ) : (
                NoAddedReposBanner
            )}
        </div>
    )
}