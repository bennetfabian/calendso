import type { Browser, Page, WorkerInfo } from "@playwright/test";
import { expect } from "@playwright/test";
import type Prisma from "@prisma/client";
import type { Team } from "@prisma/client";
import { Prisma as PrismaType } from "@prisma/client";
import { hashSync as hash } from "bcryptjs";
import { uuid } from "short-uuid";
import { v4 } from "uuid";

import updateChildrenEventTypes from "@calcom/features/ee/managed-event-types/lib/handleChildrenEventTypes";
import stripe from "@calcom/features/ee/payments/server/stripe";
import { DEFAULT_SCHEDULE, getAvailabilityFromSchedule } from "@calcom/lib/availability";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { ProfileRepository } from "@calcom/lib/server/repository/profile";
import { prisma } from "@calcom/prisma";
import { MembershipRole, SchedulingType, TimeUnit, WorkflowTriggerEvents } from "@calcom/prisma/enums";
import { teamMetadataSchema } from "@calcom/prisma/zod-utils";
import type { Schedule } from "@calcom/types/schedule";

import { createRoutingForm } from "../lib/test-helpers/routingFormHelpers";
import { selectFirstAvailableTimeSlotNextMonth, teamEventSlug, teamEventTitle } from "../lib/testUtils";
import type { createEmailsFixture } from "./emails";
import { TimeZoneEnum } from "./types";

// Don't import hashPassword from app as that ends up importing next-auth and initializing it before NEXTAUTH_URL can be updated during tests.
export function hashPassword(password: string) {
  const hashedPassword = hash(password, 12);
  return hashedPassword;
}

type UserFixture = ReturnType<typeof createUserFixture>;

export type CreateUsersFixture = ReturnType<typeof createUsersFixture>;

const userIncludes = PrismaType.validator<PrismaType.UserInclude>()({
  eventTypes: true,
  workflows: true,
  credentials: true,
  routingForms: true,
});

type InstallStripeParamsSkipTrue = {
  eventTypeIds?: number[];
  skip: true;
};

type InstallStripeParamsSkipFalse = {
  skip: false;
  eventTypeIds: number[];
};
type InstallStripeParamsUnion = InstallStripeParamsSkipTrue | InstallStripeParamsSkipFalse;
type InstallStripeTeamPramas = InstallStripeParamsUnion & {
  page: Page;
  teamId: number;
};
type InstallStripePersonalPramas = InstallStripeParamsUnion & {
  page: Page;
};

type InstallStripeParams = InstallStripeParamsUnion & {
  redirectUrl: string;
  buttonSelector: string;
  page: Page;
};

const userWithEventTypes = PrismaType.validator<PrismaType.UserArgs>()({
  include: userIncludes,
});

const seededForm = {
  id: "948ae412-d995-4865-875a-48302588de03",
  name: "Seeded Form - Pro",
};

type UserWithIncludes = PrismaType.UserGetPayload<typeof userWithEventTypes>;

const createTeamWorkflow = async (user: { id: number }, team: { id: number }) => {
  return await prisma.workflow.create({
    data: {
      name: "Team Workflow",
      trigger: WorkflowTriggerEvents.BEFORE_EVENT,
      time: 24,
      timeUnit: TimeUnit.HOUR,
      userId: user.id,
      teamId: team.id,
    },
  });
};

export const createTeamEventType = async (
  user: { id: number },
  team: { id: number },
  scenario?: {
    schedulingType?: SchedulingType;
    teamEventTitle?: string;
    teamEventSlug?: string;
    teamEventLength?: number;
    seatsPerTimeSlot?: number;
    managedEventUnlockedFields?: Record<string, boolean>;
    assignAllTeamMembers?: boolean;
  }
) => {
  return await prisma.eventType.create({
    data: {
      team: {
        connect: {
          id: team.id,
        },
      },
      users: {
        connect: {
          id: user.id,
        },
      },
      owner: {
        connect: {
          id: user.id,
        },
      },
      hosts: {
        create: {
          userId: user.id,
          isFixed: scenario?.schedulingType === SchedulingType.COLLECTIVE ? true : false,
        },
      },
      schedulingType: scenario?.schedulingType ?? SchedulingType.COLLECTIVE,
      title: scenario?.teamEventTitle ?? `${teamEventTitle}-team-id-${team.id}`,
      slug: scenario?.teamEventSlug ?? `${teamEventSlug}-team-id-${team.id}`,
      length: scenario?.teamEventLength ?? 30,
      seatsPerTimeSlot: scenario?.seatsPerTimeSlot,
      locations: [{ type: "integrations:daily" }],
      metadata:
        scenario?.schedulingType === SchedulingType.MANAGED
          ? {
              managedEventConfig: {
                unlockedFields: {
                  locations: true,
                  scheduleId: true,
                  destinationCalendar: true,
                  ...scenario?.managedEventUnlockedFields,
                },
              },
            }
          : undefined,
      assignAllTeamMembers: scenario?.assignAllTeamMembers,
    },
  });
};

const createTeamAndAddUser = async (
  {
    user,
    isUnpublished,
    isOrg,
    isOrgVerified,
    hasSubteam,
    organizationId,
    isDnsSetup,
    index,
    orgRequestedSlug,
    schedulingType,
    assignAllTeamMembersForSubTeamEvents,
  }: {
    user: { id: number; email: string; username: string | null; role?: MembershipRole };
    isUnpublished?: boolean;
    isOrg?: boolean;
    isOrgVerified?: boolean;
    isDnsSetup?: boolean;
    hasSubteam?: true;
    organizationId?: number | null;
    index?: number;
    orgRequestedSlug?: string;
    schedulingType?: SchedulingType;
    assignAllTeamMembersForSubTeamEvents?: boolean;
  },
  workerInfo: WorkerInfo
) => {
  const slugIndex = index ? `-count-${index}` : "";
  const slug =
    orgRequestedSlug ?? `${isOrg ? "org" : "team"}-${workerInfo.workerIndex}-${Date.now()}${slugIndex}`;
  const data: PrismaType.TeamCreateInput = {
    name: `user-id-${user.id}'s ${isOrg ? "Org" : "Team"}`,
    isOrganization: isOrg,
  };
  data.metadata = {
    ...(isUnpublished ? { requestedSlug: slug } : {}),
  };
  if (isOrg) {
    data.organizationSettings = {
      create: {
        orgAutoAcceptEmail: user.email.split("@")[1],
        isOrganizationVerified: !!isOrgVerified,
        isOrganizationConfigured: isDnsSetup,
      },
    };
  }

  data.slug = !isUnpublished ? slug : undefined;
  if (isOrg && hasSubteam) {
    const team = await createTeamAndAddUser({ user }, workerInfo);
    await createTeamEventType(user, team, {
      schedulingType: schedulingType,
      assignAllTeamMembers: assignAllTeamMembersForSubTeamEvents,
    });
    await createTeamWorkflow(user, team);
    data.children = { connect: [{ id: team.id }] };
  }
  data.orgProfiles = isOrg
    ? {
        create: [
          {
            uid: ProfileRepository.generateProfileUid(),
            username: user.username ?? user.email.split("@")[0],
            user: {
              connect: {
                id: user.id,
              },
            },
          },
        ],
      }
    : undefined;
  data.parent = organizationId ? { connect: { id: organizationId } } : undefined;
  const team = await prisma.team.create({
    data,
  });

  const { role = MembershipRole.OWNER, id: userId } = user;
  await prisma.membership.create({
    data: {
      createdAt: new Date(),
      teamId: team.id,
      userId,
      role: role,
      accepted: true,
    },
  });

  return team;
};

// creates a user fixture instance and stores the collection
export const createUsersFixture = (
  page: Page,
  emails: ReturnType<typeof createEmailsFixture>,
  workerInfo: WorkerInfo
) => {
  const store = { users: [], trackedEmails: [], page, teams: [] } as {
    users: UserFixture[];
    trackedEmails: { email: string }[];
    page: Page;
    teams: Team[];
  };
  return {
    buildForSignup: (opts?: Pick<CustomUserOpts, "email" | "username" | "useExactUsername" | "password">) => {
      const uname =
        opts?.useExactUsername && opts?.username
          ? opts.username
          : `${opts?.username || "user"}-${workerInfo.workerIndex}-${Date.now()}`;
      return {
        username: uname,
        email: opts?.email ?? `${uname}@example.com`,
        password: opts?.password ?? uname,
      };
    },
    /**
     * In case organizationId is passed, it simulates a scenario where a nonexistent user is added to an organization.
     */
    create: async (
      opts?:
        | (CustomUserOpts & {
            organizationId?: number | null;
            overrideDefaultEventTypes?: boolean;
          })
        | null,
      scenario: {
        seedRoutingForms?: boolean;
        seedRoutingFormWithAttributeRouting?: boolean;
        hasTeam?: true;
        numberOfTeams?: number;
        teamRole?: MembershipRole;
        teammates?: CustomUserOpts[];
        schedulingType?: SchedulingType;
        teamEventTitle?: string;
        teamEventSlug?: string;
        teamEventLength?: number;
        isOrg?: boolean;
        isOrgVerified?: boolean;
        isDnsSetup?: boolean;
        hasSubteam?: true;
        isUnpublished?: true;
        seatsPerTimeSlot?: number;
        addManagedEventToTeamMates?: boolean;
        managedEventUnlockedFields?: Record<string, boolean>;
        orgRequestedSlug?: string;
        assignAllTeamMembers?: boolean;
        assignAllTeamMembersForSubTeamEvents?: boolean;
      } = {}
    ) => {
      const _user = await prisma.user.create({
        data: createUser(workerInfo, opts),
        include: {
          profiles: true,
        },
      });

      let defaultEventTypes: SupportedTestEventTypes[] = opts?.overrideDefaultEventTypes
        ? []
        : [
            { title: "30 min", slug: "30-min", length: 30 },
            { title: "Paid", slug: "paid", length: 30, price: 1000 },
            { title: "Opt in", slug: "opt-in", requiresConfirmation: true, length: 30 },
            { title: "Seated", slug: "seated", seatsPerTimeSlot: 2, length: 30 },
            {
              title: "Multiple duration",
              slug: "multiple-duration",
              length: 30,
              metadata: { multipleDuration: [30, 60, 90] },
            },
          ];

      if (opts?.eventTypes) defaultEventTypes = defaultEventTypes.concat(opts.eventTypes);
      for (const eventTypeData of defaultEventTypes) {
        eventTypeData.owner = { connect: { id: _user.id } };
        eventTypeData.users = { connect: { id: _user.id } };
        if (_user.profiles[0]) {
          eventTypeData.profile = { connect: { id: _user.profiles[0].id } };
        }
        await prisma.eventType.create({
          data: eventTypeData,
        });
      }

      const workflows: SupportedTestWorkflows[] = [
        { name: "Default Workflow", trigger: "NEW_EVENT" },
        { name: "Test Workflow", trigger: "EVENT_CANCELLED" },
        ...(opts?.workflows || []),
      ];
      for (const workflowData of workflows) {
        workflowData.user = { connect: { id: _user.id } };
        await prisma.workflow.create({
          data: workflowData,
        });
      }

      const user = await prisma.user.findUniqueOrThrow({
        where: { id: _user.id },
        include: userIncludes,
      });
      if (scenario.hasTeam) {
        const numberOfTeams = scenario.numberOfTeams || 1;
        for (let i = 0; i < numberOfTeams; i++) {
          const team = await createTeamAndAddUser(
            {
              user: {
                id: user.id,
                email: user.email,
                username: user.username,
                role: scenario.teamRole || "OWNER",
              },
              isUnpublished: scenario.isUnpublished,
              isOrg: scenario.isOrg,
              isOrgVerified: scenario.isOrgVerified,
              isDnsSetup: scenario.isDnsSetup,
              hasSubteam: scenario.hasSubteam,
              organizationId: opts?.organizationId,
              orgRequestedSlug: scenario.orgRequestedSlug,
              schedulingType: scenario.schedulingType,
              assignAllTeamMembersForSubTeamEvents: scenario.assignAllTeamMembersForSubTeamEvents,
            },
            workerInfo
          );
          store.teams.push(team);
          const teamEvent = await createTeamEventType(user, team, scenario);
          if (scenario.teammates) {
            // Create Teammate users
            const teamMates = [];
            for (const teammateObj of scenario.teammates) {
              const teamUser = await prisma.user.create({
                data: createUser(workerInfo, teammateObj),
              });

              // Add teammates to the team
              await prisma.membership.create({
                data: {
                  createdAt: new Date(),
                  teamId: team.id,
                  userId: teamUser.id,
                  role: MembershipRole.MEMBER,
                  accepted: true,
                },
              });

              // Add teammate to the host list of team event
              await prisma.host.create({
                data: {
                  userId: teamUser.id,
                  eventTypeId: teamEvent.id,
                  isFixed: scenario.schedulingType === SchedulingType.COLLECTIVE ? true : false,
                },
              });

              const teammateFixture = createUserFixture(
                await prisma.user.findUniqueOrThrow({
                  where: { id: teamUser.id },
                  include: userIncludes,
                }),
                store.page
              );
              teamMates.push(teamUser);
              store.users.push(teammateFixture);
            }
            // If the teamEvent is a managed one, we add the team mates to it.
            if (scenario.schedulingType === SchedulingType.MANAGED && scenario.addManagedEventToTeamMates) {
              await updateChildrenEventTypes({
                eventTypeId: teamEvent.id,
                currentUserId: user.id,
                oldEventType: {
                  team: null,
                },
                updatedEventType: teamEvent,
                children: teamMates.map((tm) => ({
                  hidden: false,
                  owner: {
                    id: tm.id,
                    name: tm.name || tm.username || "Nameless",
                    email: tm.email,
                    eventTypeSlugs: [],
                  },
                })),
                profileId: null,
                prisma,
                updatedValues: {},
              });
            }
            // Add Teammates to OrgUsers
            if (scenario.isOrg) {
              const orgProfilesCreate = teamMates
                .map((teamUser) => ({
                  user: {
                    connect: {
                      id: teamUser.id,
                    },
                  },
                  uid: v4(),
                  username: teamUser.username || teamUser.email.split("@")[0],
                }))
                .concat([
                  {
                    user: { connect: { id: user.id } },
                    uid: v4(),
                    username: user.username || user.email.split("@")[0],
                  },
                ]);

              const existingProfiles = await prisma.profile.findMany({
                where: {
                  userId: _user.id,
                },
              });

              await prisma.team.update({
                where: {
                  id: team.id,
                },
                data: {
                  orgProfiles: _user.profiles.length
                    ? {
                        connect: _user.profiles.map((profile) => ({ id: profile.id })),
                      }
                    : {
                        create: orgProfilesCreate.filter(
                          (profile) =>
                            !existingProfiles.map((p) => p.userId).includes(profile.user.connect.id)
                        ),
                      },
                },
              });
            }
          }
        }
      }

      if (scenario.seedRoutingForms) {
        const firstTeamMembership = await prisma.membership.findFirstOrThrow({
          where: {
            userId: _user.id,
            team: {
              isOrganization: false,
            },
          },
        });
        if (!firstTeamMembership) {
          throw new Error("No sub-team created");
        }
        await createRoutingForm({
          userId: _user.id,
          teamId: firstTeamMembership.teamId,
          formType: scenario.seedRoutingFormWithAttributeRouting ? "attributeRouting" : "default",
          ...(scenario.seedRoutingFormWithAttributeRouting && {
            attributeRouting: {
              attributes: [
                {
                  name: "Department",
                  type: "SINGLE_SELECT" as const,
                  options: ["Engineering", "Sales", "Marketing", "Product", "Design"],
                },
                {
                  name: "Location",
                  type: "SINGLE_SELECT" as const,
                  options: ["New York", "London", "Tokyo", "Berlin", "Remote"],
                },
                {
                  name: "Skills",
                  type: "MULTI_SELECT" as const,
                  options: ["JavaScript", "React", "Node.js", "Python", "Design", "Sales"],
                },
                {
                  name: "Years of Experience",
                  type: "NUMBER" as const,
                },
                {
                  name: "Bio",
                  type: "TEXT" as const,
                },
              ],
              assignments: [
                {
                  memberIndex: 0,
                  attributeValues: {
                    Location: ["New York"],
                    Skills: ["JavaScript"],
                  },
                },
                {
                  memberIndex: 1,
                  attributeValues: {
                    Location: ["London"],
                    Skills: ["React", "JavaScript"],
                  },
                },
              ],
              teamEvents: [
                {
                  title: "Team Sales",
                  slug: "team-sales",
                  schedulingType: "ROUND_ROBIN",
                  assignAllTeamMembers: true,
                  length: 60,
                  description: "Team Sales",
                },
                {
                  title: "Team Javascript",
                  slug: "team-javascript",
                  schedulingType: "ROUND_ROBIN",
                  assignAllTeamMembers: true,
                  length: 60,
                  description: "Team Javascript",
                },
              ],
            },
          }),
        });
      }

      const finalUser = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        include: userIncludes,
      });
      const userFixture = createUserFixture(finalUser, store.page);
      store.users.push(userFixture);
      return userFixture;
    },
    /**
     * Use this method to get an email that can be automatically cleaned up from all the places in DB
     */
    trackEmail: ({ username, domain }: { username: string; domain: string }) => {
      const email = `${username}-${uuid().substring(0, 8)}@${domain}`;
      store.trackedEmails.push({
        email,
      });
      return email;
    },
    get: () => store.users,
    logout: async () => {
      await page.goto("/auth/logout");
    },
    deleteAll: async () => {
      const ids = store.users.map((u) => u.id);
      if (emails) {
        const emailMessageIds: string[] = [];
        for (const user of store.trackedEmails.concat(store.users.map((u) => ({ email: u.email })))) {
          const emailMessages = await emails.search(user.email);
          if (emailMessages && emailMessages.count > 0) {
            emailMessages.items.forEach((item) => {
              emailMessageIds.push(item.ID);
            });
          }
        }
        for (const id of emailMessageIds) {
          await emails.deleteMessage(id);
        }
      }

      await prisma.user.deleteMany({ where: { id: { in: ids } } });
      // Delete all users that were tracked by email(if they were created)
      await prisma.user.deleteMany({ where: { email: { in: store.trackedEmails.map((e) => e.email) } } });
      await prisma.team.deleteMany({ where: { id: { in: store.teams.map((org) => org.id) } } });
      await prisma.secondaryEmail.deleteMany({ where: { userId: { in: ids } } });
      store.users = [];
      store.teams = [];
      store.trackedEmails = [];
    },
    delete: async (id: number) => {
      await prisma.user.delete({ where: { id } });
      store.users = store.users.filter((b) => b.id !== id);
    },
    deleteByEmail: async (email: string) => {
      // Use deleteMany instead of delete to avoid the findUniqueOrThrow error that happens before the delete
      await prisma.user.deleteMany({
        where: {
          email,
        },
      });
      store.users = store.users.filter((b) => b.email !== email);
    },
    set: async (email: string) => {
      const user = await prisma.user.findUniqueOrThrow({
        where: { email },
        include: userIncludes,
      });
      const userFixture = createUserFixture(user, store.page);
      store.users.push(userFixture);
      return userFixture;
    },
  };
};

type JSONValue = string | number | boolean | { [x: string]: JSONValue } | Array<JSONValue>;

// creates the single user fixture
const createUserFixture = (user: UserWithIncludes, page: Page) => {
  const store = { user, page };

  // self is a reflective method that return the Prisma object that references this fixture.
  const self = async () =>
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    (await prisma.user.findUnique({
      where: { id: store.user.id },
      include: { eventTypes: true },
    }))!;
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    eventTypes: user.eventTypes,
    routingForms: user.routingForms,
    self,
    apiLogin: async (password?: string) =>
      apiLogin({ ...(await self()), password: password || user.username }, store.page),
    /** Don't forget to close context at the end */
    apiLoginOnNewBrowser: async (browser: Browser, password?: string) => {
      const newContext = await browser.newContext();
      const newPage = await newContext.newPage();
      await apiLogin({ ...(await self()), password: password || user.username }, newPage);
      // Don't forget to: newContext.close();
      return [newContext, newPage] as const;
    },
    /**
     * @deprecated use apiLogin instead
     */
    login: async () => login({ ...(await self()), password: user.username }, store.page),
    loginOnNewBrowser: async (browser: Browser) => {
      const newContext = await browser.newContext();
      const newPage = await newContext.newPage();
      await login({ ...(await self()), password: user.username }, newPage);
      // Don't forget to: newContext.close();
      return [newContext, newPage] as const;
    },
    logout: async () => {
      await page.goto("/auth/logout");
    },
    getFirstTeamMembership: async () => {
      const memberships = await prisma.membership.findMany({
        where: { userId: user.id },
        include: { team: true, user: true },
      });

      const membership = memberships
        .map((membership) => {
          return {
            ...membership,
            team: {
              ...membership.team,
              metadata: teamMetadataSchema.parse(membership.team.metadata),
            },
          };
        })
        .find((membership) => !membership.team.isOrganization);
      if (!membership) {
        throw new Error("No team found for user");
      }
      return membership;
    },
    getOrgMembership: async () => {
      const membership = await prisma.membership.findFirstOrThrow({
        where: {
          userId: user.id,
          team: {
            isOrganization: true,
          },
        },
        include: {
          team: {
            include: {
              children: true,
              organizationSettings: true,
            },
          },
        },
      });
      if (!membership) {
        return membership;
      }

      return {
        ...membership,
        team: {
          ...membership.team,
          metadata: teamMetadataSchema.parse(membership.team.metadata),
        },
      };
    },
    getFirstEventAsOwner: async () =>
      prisma.eventType.findFirstOrThrow({
        where: {
          userId: user.id,
        },
      }),
    getUserEventsAsOwner: async () =>
      prisma.eventType.findMany({
        where: {
          userId: user.id,
        },
      }),
    getFirstTeamEvent: async (teamId: number, schedulingType?: SchedulingType) => {
      return prisma.eventType.findFirstOrThrow({
        where: {
          teamId,
          schedulingType,
        },
      });
    },
    setupEventWithPrice: async (eventType: Pick<Prisma.EventType, "id">, slug: string) =>
      setupEventWithPrice(eventType, slug, store.page),
    bookAndPayEvent: async (eventType: Pick<Prisma.EventType, "slug">) =>
      bookAndPayEvent(user, eventType, store.page),
    makePaymentUsingStripe: async () => makePaymentUsingStripe(store.page),
    installStripePersonal: async (params: InstallStripeParamsUnion) =>
      installStripePersonal({ page: store.page, ...params }),
    installStripeTeam: async (params: InstallStripeParamsUnion & { teamId: number }) =>
      installStripeTeam({ page: store.page, ...params }),
    // this is for development only aimed to inject debugging messages in the metadata field of the user
    debug: async (message: string | Record<string, JSONValue>) => {
      await prisma.user.update({
        where: { id: store.user.id },
        data: { metadata: { debug: message } },
      });
    },
    delete: async () => await prisma.user.delete({ where: { id: store.user.id } }),
    confirmPendingPayment: async () => confirmPendingPayment(store.page),
    getFirstProfile: async () => {
      return prisma.profile.findFirstOrThrow({
        where: {
          userId: user.id,
        },
      });
    },
  };
};

type SupportedTestEventTypes = PrismaType.EventTypeCreateInput & {
  _bookings?: PrismaType.BookingCreateInput[];
};

type SupportedTestWorkflows = PrismaType.WorkflowCreateInput;

type CustomUserOptsKeys =
  | "username"
  | "completedOnboarding"
  | "locale"
  | "name"
  | "email"
  | "organizationId"
  | "twoFactorEnabled"
  | "disableImpersonation"
  | "role"
  | "identityProvider";
type CustomUserOpts = Partial<Pick<Prisma.User, CustomUserOptsKeys>> & {
  timeZone?: TimeZoneEnum;
  eventTypes?: SupportedTestEventTypes[];
  workflows?: SupportedTestWorkflows[];
  // ignores adding the worker-index after username
  useExactUsername?: boolean;
  roleInOrganization?: MembershipRole;
  schedule?: Schedule;
  password?: string | null;
  emailDomain?: string;
  profileUsername?: string;
};

// creates the actual user in the db.
const createUser = (
  workerInfo: WorkerInfo,
  opts?:
    | (CustomUserOpts & {
        organizationId?: number | null;
      })
    | null
): PrismaType.UserUncheckedCreateInput => {
  const suffixToMakeUsernameUnique = `-${workerInfo.workerIndex}-${Date.now()}`;
  // build a unique name for our user
  const uname =
    opts?.useExactUsername && opts?.username
      ? opts.username
      : `${opts?.username || "user"}${suffixToMakeUsernameUnique}`;

  const emailDomain = opts?.emailDomain || "example.com";
  return {
    username: uname,
    name: opts?.name,
    email: opts?.email ?? `${uname}@${emailDomain}`,
    password: {
      create: {
        hash: hashPassword(uname),
      },
    },
    emailVerified: new Date(),
    completedOnboarding: opts?.completedOnboarding ?? true,
    timeZone: opts?.timeZone ?? TimeZoneEnum.UK,
    locale: opts?.locale ?? "en",
    role: opts?.role ?? "USER",
    twoFactorEnabled: opts?.twoFactorEnabled ?? false,
    disableImpersonation: opts?.disableImpersonation ?? false,
    ...getOrganizationRelatedProps({
      organizationId: opts?.organizationId,
      role: opts?.roleInOrganization,
      profileUsername: opts?.profileUsername,
    }),
    schedules:
      opts?.completedOnboarding ?? true
        ? {
            create: {
              name: "Working Hours",
              timeZone: opts?.timeZone ?? TimeZoneEnum.UK,
              availability: {
                createMany: {
                  data: getAvailabilityFromSchedule(opts?.schedule ?? DEFAULT_SCHEDULE),
                },
              },
            },
          }
        : undefined,
    identityProvider: opts?.identityProvider,
  };

  function getOrganizationRelatedProps({
    organizationId,
    role,
    profileUsername,
  }: {
    organizationId: number | null | undefined;
    role: MembershipRole | undefined;
    profileUsername?: string;
  }) {
    if (!organizationId) {
      return null;
    }
    if (!role) {
      throw new Error("Missing role for user in organization");
    }
    return {
      organizationId,
      profiles: {
        create: {
          uid: ProfileRepository.generateProfileUid(),
          username: profileUsername ? `${profileUsername}${suffixToMakeUsernameUnique}` : uname,
          organization: {
            connect: {
              id: organizationId,
            },
          },
        },
      },
      teams: {
        // Create membership
        create: [
          {
            team: {
              connect: {
                id: organizationId,
              },
            },
            accepted: true,
            role,
          },
        ],
      },
    };
  }
};

async function confirmPendingPayment(page: Page) {
  await page.waitForURL(new RegExp("/booking/*"));

  const url = page.url();

  const params = new URLSearchParams(url.split("?")[1]);

  const id = params.get("payment_intent");

  if (!id) throw new Error(`Payment intent not found in url ${url}`);

  const payload = JSON.stringify(
    { type: "payment_intent.succeeded", data: { object: { id } }, account: "e2e_test" },
    null,
    2
  );

  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET as string,
  });

  const response = await page.request.post("/api/integrations/stripepayment/webhook", {
    data: payload,
    headers: { "stripe-signature": signature },
  });

  if (response.status() !== 200)
    throw new Error(`Failed to confirm payment. Response: ${await response.text()}`);
}

// login using a replay of an E2E routine.
export async function login(
  user: Pick<Prisma.User, "username"> & Partial<Pick<Prisma.User, "email">> & { password?: string | null },
  page: Page
) {
  // get locators
  const loginLocator = page.locator("[data-testid=login-form]");
  const emailLocator = loginLocator.locator("#email");
  const passwordLocator = loginLocator.locator("#password");
  const signInLocator = loginLocator.locator('[type="submit"]');

  //login
  await page.goto("/");
  await page.waitForSelector("text=Welcome back");

  await emailLocator.fill(user.email ?? `${user.username}@example.com`);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  await passwordLocator.fill(user.password ?? user.username!);

  // waiting for specific login request to resolve
  const responsePromise = page.waitForResponse(/\/api\/auth\/callback\/credentials/);
  await signInLocator.click();
  await responsePromise;
}

export async function apiLogin(
  user: Pick<Prisma.User, "username"> & Partial<Pick<Prisma.User, "email">> & { password: string | null },
  page: Page
) {
  const csrfToken = await page
    .context()
    .request.get("/api/auth/csrf")
    .then((response) => response.json())
    .then((json) => json.csrfToken);
  const data = {
    email: user.email ?? `${user.username}@example.com`,
    password: user.password ?? user.username,
    callbackURL: WEBAPP_URL,
    redirect: "false",
    json: "true",
    csrfToken,
  };
  const response = await page.context().request.post("/api/auth/callback/credentials", {
    data,
  });
  expect(response.status()).toBe(200);
  return response;
}

export async function setupEventWithPrice(eventType: Pick<Prisma.EventType, "id">, slug: string, page: Page) {
  await page.goto(`/event-types/${eventType?.id}?tabName=apps`);
  await page.locator(`[data-testid='${slug}-app-switch']`).first().click();
  await page.getByPlaceholder("Price").fill("100");
  await page.getByTestId("update-eventtype").click();
}

export async function bookAndPayEvent(
  user: Pick<Prisma.User, "username">,
  eventType: Pick<Prisma.EventType, "slug">,
  page: Page
) {
  // booking process with stripe integration
  await page.goto(`${user.username}/${eventType?.slug}`);
  await selectFirstAvailableTimeSlotNextMonth(page);
  // --- fill form
  await page.fill('[name="name"]', "Stripe Stripeson");
  await page.fill('[name="email"]', "test@example.com");

  await Promise.all([page.waitForURL("/payment/*"), page.press('[name="email"]', "Enter")]);

  await makePaymentUsingStripe(page);
}

export async function makePaymentUsingStripe(page: Page) {
  const stripeElement = await page.locator(".StripeElement").first();
  const stripeFrame = stripeElement.frameLocator("iframe").first();
  await stripeFrame.locator('[name="number"]').fill("4242 4242 4242 4242");
  const now = new Date();
  await stripeFrame.locator('[name="expiry"]').fill(`${now.getMonth() + 1} / ${now.getFullYear() + 1}`);
  await stripeFrame.locator('[name="cvc"]').fill("111");
  const postcalCodeIsVisible = await stripeFrame.locator('[name="postalCode"]').isVisible();
  if (postcalCodeIsVisible) {
    await stripeFrame.locator('[name="postalCode"]').fill("111111");
  }
  await page.click('button:has-text("Pay now")');
}

const installStripePersonal = async (params: InstallStripePersonalPramas) => {
  const redirectUrl = `apps/installation/event-types?slug=stripe`;
  const buttonSelector = '[data-testid="install-app-button-personal"]';
  await installStripe({ redirectUrl, buttonSelector, ...params });
};

const installStripeTeam = async ({ teamId, ...params }: InstallStripeTeamPramas) => {
  const redirectUrl = `apps/installation/event-types?slug=stripe&teamId=${teamId}`;
  const buttonSelector = `[data-testid="install-app-button-team${teamId}"]`;
  await installStripe({ redirectUrl, buttonSelector, ...params });
};
const installStripe = async ({
  page,
  skip,
  eventTypeIds,
  redirectUrl,
  buttonSelector,
}: InstallStripeParams) => {
  await page.goto("/apps/stripe");
  /** We start the Stripe flow */
  await page.click('[data-testid="install-app-button"]');
  await page.click(buttonSelector);

  await page.waitForURL("https://connect.stripe.com/oauth/v2/authorize?*");
  /** We skip filling Stripe forms (testing mode only) */
  await page.click('[id="skip-account-app"]');
  await page.waitForURL(redirectUrl);
  if (skip) {
    await page.click('[data-testid="set-up-later"]');
    return;
  }
  for (const id of eventTypeIds) {
    await page.click(`[data-testid="select-event-type-${id}"]`);
  }
  await page.click(`[data-testid="save-event-types"]`);
  for (let index = 0; index < eventTypeIds.length; index++) {
    await page.locator('[data-testid="stripe-price-input"]').nth(index).fill(`1${index}`);
  }
  await page.click(`[data-testid="configure-step-save"]`);
  await page.waitForURL(`event-types`);
  for (let index = 0; index < eventTypeIds.length; index++) {
    await page.goto(`event-types/${eventTypeIds[index]}?tabName=apps`);
    await expect(page.getByTestId(`stripe-app-switch`)).toBeChecked();
    await expect(page.getByTestId(`stripe-price-input`)).toHaveValue(`1${index}`);
  }
};
